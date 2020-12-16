import Handlebars from 'handlebars';
import Context, { IterationType } from './Context';
import ITranspiler from './ITranspiler';

export class DjangoTranspiler implements ITranspiler {
  private buffer: any[];
  private parsed: hbs.AST.Program;
  private context: Context;
  private depth: number;

  constructor(input?, context?, depth = 0) {
    this.buffer = [];
    this.context = context || new Context();
    this.depth = depth;

    if (input) {
      this.parsed = Handlebars.parse(input);
      this.parseProgram(this.parsed);
    }
  }

  parseProgram(program: hbs.AST.Program, isConditionalInInverse: boolean = false) {
    // console.log('\n\n -- PROGRAM -- \n');
    // console.log(program);
    program.body.forEach((statement: hbs.AST.ProgramStatement) => {
      switch (statement.type) {
        case 'ContentStatement':
          this.buffer.push(statement.original);
          break;

        case 'MustacheStatement':
          // console.log('\n\nMustacheStatement\n');
          // console.log(statement);
          const path = <hbs.AST.PathExpression>statement.path;
          const escaped = statement.escaped ? '' : '|safe';

          let variable;
          if (path.original === '@index') {
            variable = 'forloop.counter0';
          } else {
            variable = this.context.getScopedVariable(path);
          }

          variable = variable.replace(/-/g, '_');

          if (path.type === 'PathExpression') {
            this.buffer.push(`{{ ${variable}${escaped} }}`);
          } else if (path.type === 'Literal') {
            throw new Error('not implemented');
          }
          break;

        case 'CommentStatement':
          this.buffer.push(`{#${statement.value}#}`);
          break;

        case 'BlockStatement':
          // console.log('\n\nBlockStatement\n');
          // console.log(statement);

          const type = statement.path.original;
          switch (type) {
            case 'if': {
              const condition = statement.params[0];
              let scopedCondition;

              if (condition.type === 'SubExpression') {
                if ((condition as hbs.AST.SubExpression).path.original === 'condition') {
                  scopedCondition = (condition as hbs.AST.SubExpression).params
                    .map(param => {
                      if (param.type === 'PathExpression') {
                        return this.context.getScopedVariable(param as hbs.AST.PathExpression);
                      }
                      return (param as hbs.AST.StringLiteral).value;
                    })
                    .join(' ');
                }
              } else {
                scopedCondition = this.context.getScopedVariable(
                  condition as hbs.AST.PathExpression,
                );
              }

              // use `else if` instead of else when this is the only if statement in an else block
              this.buffer.push(`{% ${isConditionalInInverse ? 'el' : ''}if ${scopedCondition} %}`);
              const t = new DjangoTranspiler(null, this.context, this.depth);
              this.buffer.push(t.parseProgram(statement.program).toString());

              if (statement.inverse) {
                // else section
                const isInverseOnlyConditional = DjangoTranspiler.isOnlyCondition(
                  statement.inverse,
                );
                const t = new DjangoTranspiler(null, this.context, this.depth);
                t.parseProgram(statement.inverse, isInverseOnlyConditional);

                // child will render a `else if`
                if (!isInverseOnlyConditional) {
                  this.buffer.push(`{% else %}`);
                }
                this.buffer.push(t.toString());
              }

              // parent will close this
              if (!isConditionalInInverse) {
                this.buffer.push(`{% endif %}`);
              }
              break;
            }

            case 'each': {
              const condition = this.context.getScopedVariable(statement
                .params[0] as hbs.AST.PathExpression);
              let childContext: Context;

              if (statement.program.blockParams) {
                // {{#each foo as |key, value|}
                const blockParams = statement.program.blockParams;
                childContext = this.context.createChildContext(blockParams);

                // {{#each foo as |k, v|} => has 2 variable in the same context, k and v
                if (blockParams.length === 2) {
                  childContext.getCurrentScope().iterateAsObject();
                }
              } else {
                // {{#each foo}}
                childContext = this.context.createChildContext([`${condition.split('.').pop()}_i`]);
              }

              const t = new DjangoTranspiler(null, childContext, this.depth + 1);
              t.parseProgram(statement.program);
              const childScope = childContext.getCurrentScope();

              // Rules:
              // - default = array
              // - when using 2 block params = object
              // - when using @key = object

              if (childScope.iterationType === IterationType.ARRAY) {
                // Array iteration
                this.buffer.push(`{% for ${childScope.value} in ${condition} %}`);
              } else {
                // Object iteration
                let key = 'key';
                let value = 'value';

                if (childScope.value) {
                  value = childScope.value;
                  key = childScope.key || 'key';
                }

                this.buffer.push(`{% for ${key}, ${value} in ${condition}.items %}`);
              }

              this.buffer.push(t.toString());
              this.buffer.push(`{% endfor %}`);
              break;
            }

            default: {
              // tslint:disable-next-line:no-console
              console.log('Unsupported block ', type);

              this.buffer.push(`{{# ${type} }}`);

              const t = new DjangoTranspiler(null, this.context, this.depth);
              t.parseProgram(statement.program);
              this.buffer.push(t.toString());

              this.buffer.push(`{{/${type}}}`);
            }
          }
          break;

        case 'PartialStatement': {
          // console.log('\nPartialStatement\n');
          // console.log(statement);

          let name: string;
          if (statement.name.type === 'StringLiteral') {
            const expression = (statement.name as any) as hbs.AST.StringLiteral;
            name = `"${expression.value.replace('.hbs', '.html')}"`;
          } else if (statement.name.type === 'SubExpression') {
            const expression = statement.name as hbs.AST.SubExpression;
            // TODO: add generic helper support, which includes lookup
            if (expression.path.original === 'lookup') {
              // TODO: add scope support, now always assumes '.' (current scope)
              name = (<hbs.AST.StringLiteral>expression.params[1]).value;
            }
          } else {
            name = (<hbs.AST.PathExpression>statement.name).parts
              .filter(p => p !== 'hbs')
              .join('/');
            name = `"${name}.html"`;
          }

          let context = '';
          if (statement.params.length) {
            // TODO: django doesn't support pushing/replacing the context, only adding/replacing additional variables
            context = ` with ${this.context.getScopedVariable(<hbs.AST.PathExpression>statement
              .params[0])}="does-not-work"`;
          }

          let params = '';
          if (statement.hash) {
            params =
              ' with ' +
              statement.hash.pairs
                .map((pair: hbs.AST.HashPair) => {
                  const key = `${pair.key}=`.replace(/-/g, '_');
                  if (pair.value.type === 'PathExpression') {
                    return `${key}${this.context.getScopedVariable(
                      <hbs.AST.PathExpression>pair.value,
                    )}`;
                  }
                  if (pair.value.type === 'StringLiteral') {
                    return `${key}"${(<hbs.AST.StringLiteral>pair.value).value}"`;
                  }
                  if (pair.value.type === 'NumberLiteral') {
                    return `${key}${(<hbs.AST.NumberLiteral>pair.value).value}`;
                  }
                  if (pair.value.type === 'BooleanLiteral') {
                    const valueStr = `${(<hbs.AST.BooleanLiteral>pair.value).value}`;
                    const valueStrCapitalized = valueStr[0].toUpperCase() + valueStr.substr(1);
                    return `${key}${valueStrCapitalized}`;
                  }
                  return '';
                })
                .filter(_ => _)
                .join(' ');
          }

          this.buffer.push(`{% include ${name}${context}${params} %}`);

          break;
        }

        default: {
          // tslint:disable-next-line:no-console
          console.log('Unsupported statements ', statement.type);
        }
      }
    });

    return this;
  }

  /**
   * Checks if this sub-program has only a condition statement.
   * If that's the case, and used in a inverse (else) section, the parent should render `else if`
   * instead of an `if` nested in an `else`.
   * @param {hbs.AST.Program} program
   * @return {boolean}
   */
  static isOnlyCondition(program: hbs.AST.Program): boolean {
    return (
      program.body.length === 1 &&
      program.body[0].type === 'BlockStatement' &&
      (<hbs.AST.BlockStatement>program.body[0]).path.original === 'if'
    );
  }

  toString(): string {
    return this.buffer.reduce((str, op) => {
      return str + op;
    }, '');
  }
}
