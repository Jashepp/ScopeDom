"use strict";

/**
 * Plugin for adding piping support to expressions.
 * 
 * Enables pipe syntax in expressions (e.g., `count | $format.number`)
 * Transforms piped expressions into method calls
 * 
 * @class pluginPipeExp
 */
export class pluginPipeExp {
	
	/**
	 * Plugin name identifier.
	 * @type {string}
	 */
	get name(){ return 'pipe-expression'; }
	static get name(){ return 'pipe-expression'; }
	
	/**
	 * @param {Object} ScopeDom - The ScopeDom class
	 * @param {Object} instance - The ScopeDom instance
	 */
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
	}
	
	/**
	 * Called when an expression is encountered.
	 * Parses pipe syntax and transforms the expression.
	 * 
	 * When an expression contains the pipe `|` character:
	 * 1. Identifies pipe boundaries in the expression.
	 * 2. Parses each piped segment as a method call with optional arguments.
	 * 3. Transforms the expression into a nested method call chain.
	 * 
	 * @param {ExpressionInfo} expInfo - The expression information object
	 */
	onExpression(expInfo){
		let { instance, element, elementScopeCtrl, expressionObj } = expInfo;
		let { expression, mainScopes, otherScopes, options } = expressionObj;
		let hasPipe = expression.includes('|');
		if(hasPipe){
			let positions = this.#getPipeBoundaries(expression);
			let finalStack = [];
			if(positions?.size>0){
				let stack = this.#getStackFromPositions(expression,positions);
				finalStack.push(stack[0])
				// Parse methods & arguments
				for(let i=1,l=stack.length; i<l; i++){
					let exp = stack[i], hasParts = exp.includes(':'), newExp = exp;
					let innerFn = exp, innerArgs = "";
					if(hasParts){
						let innerPositions = this.#jsExpressionBoundariesFullPass(exp,":");
						if(innerPositions?.size>0){
							let stack = this.#getStackFromPositions(exp,innerPositions);
							for(let j=0,k=stack.length; j<k; j++){
								let innerExp = stack[j];
								if(j===0) innerFn = innerExp;
								else if(j===1) innerArgs = innerExp;
								else innerArgs += ","+innerExp;
							}
						}
					}
					finalStack.push([innerFn,innerArgs]);
				}
				// Combine into final expression
				expressionObj.expression = this.#reduceFinalStack(finalStack);
			}
		}
	}
	
	/**
	 * Reduces a stack of method/argument pairs into a chained method call expression.
	 * 
	 * Transforms a stack like `[["data"],["$format","2"]]` into `"$format(data,2)"`.
	 * 
	 * @param {PipeStackItem[]} stack - The stack of method/argument pairs
	 * @returns {string} The reduced expression string
	 * @private
	 */
	#reduceFinalStack(stack){
		let strStart = '', strEnd = '';
		for(let i=1,l=stack.length; i<l; i++){
			let [ method, args ] = stack[i];
			strStart = `${method}(${strStart}`;
			strEnd = `${strEnd}${args?','+args:''})`;
		}
		return `${strStart}(${stack[0]})${strEnd}`;
	}
	
	/**
	 * Builds a stack of expression segments from pipe boundary positions.
	 * 
	 * @param {string} exp - The expression string
	 * @param {Set<number>} positions - Set of pipe character positions
	 * @returns {string[]} Array of expression segments
	 * @private
	 */
	#getStackFromPositions(exp,positions){
		let stack = [], lastPos = 0;
		for(let pos of positions.values()){
			let str = exp.substring(lastPos,pos).trim();
			if(str.length>0) stack.push(str);
			lastPos = pos+1;
		}
		stack.push(exp.substring(lastPos).trim());
		return stack;
	}
	
	/**
	 * Determines pipe boundaries in an expression.
	 * 
	 * Uses pipeBoundariesFastPass for simple expressions, jsExpressionBoundariesFullPass for complex ones.
	 * 
	 * @param {string} expr - The expression string
	 * @returns {Set<number>} Set of pipe boundary positions
	 * @private
	 */
	#getPipeBoundaries(expr){
		let hasForwardSlash = expr.includes('/');
		let hasSingleQuote = expr.includes('"');
		let hasDoubleQuote = expr.includes("'");
		let hasTplLiteral = expr.includes('`');
		// Fast Pass
		if (!hasForwardSlash && !hasSingleQuote && !hasDoubleQuote && !hasTplLiteral) return this.#pipeBoundariesFastPass(expr);
		// Full Pass
		return this.#jsExpressionBoundariesFullPass(expr,"|");
	}
	
	/**
	 * Fast simple pass for pipe boundary detection.
	 * 
	 * Used for simple expressions without strings, quotes, or template literals.
	 * 
	 * @param {string} expr - The expression string
	 * @returns {Set<number>} Set of pipe boundary positions
	 * @private
	 */
	#pipeBoundariesFastPass(expr){
		let positions = new Set();
		for(let i=0,l=expr.length; i<l; i++) if(expr[i]==="|" && expr[i-1]!=="|" && expr[i+1]!=="|") positions.add(i);
		return positions;
	}
	
	/**
	 * Full pass for pipe boundary detection.
	 * 
	 * Properly handles:
	 * - String literals (single and double quotes)
	 * - Template literals with nested expressions
	 * - Regular expressions
	 * - Single-line and multi-line comments
	 * - Escaped characters
	 * 
	 * For example: "`text ${`more ${`etc`} text`}` | $display.bold"
	 * 
	 * @param {string} expr - The expression string
	 * @param {string} [specialChar='|'] - The special character to detect
	 * @returns {Set<number>} Set of special character positions
	 * @private
	 */
	#jsExpressionBoundariesFullPass(expr,specialChar="|"){
		let positions = new Set();
		let type = 0; // 1=string, 2=tplLiteral, 4=regex, 5=commentDS, 6=commentML
		let stringChar=null, stack=[], stateTpl={ closureCount:0, bracketCount:0 };
		stack.push({ ...stateTpl });
		for(let i=0,l=expr.length; i<l; i++){
			let char=expr[i], prev=expr[i-1], next=expr[i+1], state=stack[stack.length-1];
			// Template Literal Expression End
			if(stack.length>1 && type===0 && state.closureCount===0 && state.bracketCount===0 && char=="}" && prev!=="\\"){
				type = 2;
				stack.pop();
				continue;
			}
			// Type Switch
			switch(type){
				case 1: // String End
					if(char==stringChar && prev!=="\\") type = 0;
				break;
				case 2:
					// Template Literal Expression Handle
					if(char=="$" && next==="{" && prev!=="\\"){
						i++;
						type = 0;
						stack.push({ ...stateTpl });
					}
					// Template Literal End
					else if(char=="`" && prev!=="\\") type = 0;
				break;
				case 4: // Regex End
					if(char==="/" && prev!=="\\") type = 0;
				break;
				case 5: // Comment Double Slash
					if(char==="\n") type = 0;
				break;
				case 6: // Comment Multi Line
					if(char==="/" && prev==="*") type = 0;
				break;
				default: // Character Switch
					switch(char){
						case '"': case "'": // String Start
							if(prev!=="\\"){
								type = 1;
								stringChar = char;
							}
						break;
						case "`": // Template Literal Start
							if(prev!=="\\") type = 2;
						break;
						case "/": // Regex Start
							if(prev!=="/" && next!=="/" && next!=="*" && this.#isRegexPos(expr,i)) type = 4;
						break;
						case "/":
							// Comment Double Slash
							if(next==="/") type = 5;
							// Comment Multi Line
							else if(next==="*") type = 6;
						break;
						case "{": // Closure Start
							if(prev!=="\\") state.closureCount++;
						break;
						case "}": // Closure End
							if(prev!=="\\") state.closureCount--;
						break;
						case "(": // Bracket Start
							if(prev!=="\\") state.bracketCount++;
						break;
						case ")": // Bracket End
							if(prev!=="\\") state.bracketCount--;
						break;
						case specialChar: // Special Character
							if(state.closureCount===0 && state.bracketCount===0 && stack.length===1){
								if(specialChar==="|" && prev!=="|" && next!=="|") positions.add(i);
								else if(specialChar!=="|") positions.add(i);
							}
						default:
						break;
					}
				break;
			}
		}
		if(type===1) throw new SyntaxError("SyntaxError: Unfinished String");
		if(type===2) throw new SyntaxError("SyntaxError: Unfinished Template Literal");
		if(stack.length>1) throw new SyntaxError("SyntaxError: Unfinished Template Literal Expression");
		if(stack[0]?.closureCount>0) throw new SyntaxError("SyntaxError: Unfinished Closure");
		if(stack[0]?.bracketCount>0) throw new SyntaxError("SyntaxError: Unfinished Brackets");
		return positions;
	}
	
	/**
	 * Distinguishes between '/' as regex delimiter and '/' as division operator.
	 * 
	 * Checks context before and after the '/' to determine if it's regex:
	 * - Before: Must be preceded by regex-friendly characters (operators, punctuation)
	 * - After: Must match regex closing pattern (e.g., `/pattern/g` or /pattern/.test(str))
	 * 
	 * @param {string} expr - The full expression string
	 * @param {number} index - The index of the '/' character to check
	 * @returns {boolean} True if the '/' is part of a regex literal
	 * @private
	 */
	#isRegexPos(expr,index){
		let str = expr.substring(0,index+1);
		let before = index===0 || /([\,\.\[\(\{\}\;\:\-\+\=\&\|\?]|\*\/|\/\/.*?\n|^)\s*?\/$/.test(str);
		if(!before) return false;
		let str2 = expr.substring(index);
		let after = /^\/[^\n]*?[^\\]\/[a-z]?\s*?[\,\.\;\)\]\[\}]/.test(str2);
		return after;
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginPipeExp) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginPipeExp=pluginPipeExp);
