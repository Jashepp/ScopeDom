"use strict";

export class pluginPipeExp {
	get name(){ return 'pipe-expression'; }
	
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
	}
	
	onExpression(expInfo){
		let { instance, element, elementScopeCtrl, expressionObj } = expInfo;
		let { expression, mainScopes, otherScopes, options } = expressionObj;
		let hasPipe = expression.includes('|');
		if(hasPipe){
			let positions = this.getPipeBoundaries(expression);
			let finalStack = [];
			if(positions?.size>0){
				let stack = this.getStackFromPositions(expression,positions);
				finalStack.push(stack[0])
				// Combine into c(b(a(value)))
				for(let i=1,l=stack.length; i<l; i++){
					let exp = stack[i], hasParts = exp.includes(':'), newExp = exp;
					let innerFn = exp, innerArgs = "";
					// Parse function arguments
					if(hasParts){
						let innerPositions = this.jsExpressionBoundariesFullPass(exp,":");
						if(innerPositions?.size>0){
							let stack = this.getStackFromPositions(exp,innerPositions);
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
				expressionObj.expression = this.reduceFinalStack(finalStack);
			}
		}
	}
	
	reduceFinalStack(stack){
		let strStart = '', strEnd = '';
		for(let i=1,l=stack.length; i<l; i++){
			let [ method, args ] = stack[i];
			if(method.substring(0,6)==='await ') strStart = `await (${method.substring(6)})(${strStart}`;
			else strStart = `(${method})(${strStart}`;
			strEnd = `${strEnd}${args?','+args:''})`;
		}
		return `${strStart}(${stack[0]})${strEnd}`;
	}
	
	getStackFromPositions(exp,positions){
		let stack = [], lastPos = 0;
		for(let pos of positions.values()){
			let str = exp.substring(lastPos,pos).trim();
			if(str.length>0) stack.push(str);
			lastPos = pos+1;
		}
		stack.push(exp.substring(lastPos).trim());
		return stack;
	}
	
	getPipeBoundaries(expr){
		let hasForwardSlash = expr.includes('/');
		let hasSingleQuote = expr.includes('"');
		let hasDoubleQuote = expr.includes("'");
		let hasTplLiteral = expr.includes('`');
		let hasTplLiteralExp = hasTplLiteral && expr.includes('${');
		// Fast Pass
		if (!hasForwardSlash && !hasSingleQuote && !hasDoubleQuote && !hasTplLiteral) return this.pipeBoundariesFastPass(expr);
		// Full Pass
		return this.jsExpressionBoundariesFullPass(expr,"|");
	}
	
	/**
	 * Fast Simple Pass
	 * For expressions like: "count | $format.number"
	 */
	pipeBoundariesFastPass(expr){
		let positions = new Set();
		for(let i=0,l=expr.length; i<l; i++) if(expr[i]==="|" && expr[i-1]!=="|" && expr[i+1]!=="|") positions.add(i);
		return positions;
	}
	
	/**
	 * Full Pass
	 * For expressions like: "`text ${`more ${`etc`} text`}` | $display.bold"
	 */
	jsExpressionBoundariesFullPass(expr,specialChar="|"){
		let positions = new Set();
		let type = 0; // 1=string, 2=tplLiteral, 4=regex, 5=commentDS, 6=commentML
		let stringChar=null, state=[], stateTpl={ bracketCount:0 }, tplLiteralCount=0;
		state.push({ ...stateTpl });
		for(let i=0,l=expr.length; i<l; i++){
			let char=expr[i], prev=expr[i-1], next=expr[i+1], stateObj=state[state.length-1];
			// Template Literal Expression End
			if(tplLiteralCount>0 && type===0 && stateObj.bracketCount===0 && char=="}" && prev!=="\\"){
				tplLiteralCount--;
				type = 2;
				state.pop();
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
						tplLiteralCount++;
						i++;
						type = 0;
						state.push({ ...stateTpl });
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
							if(prev!=="/" && next!=="/" && next!=="*" && isRegexPos(expr,i)) type = 4;
						break;
						case "/":
							// Comment Double Slash
							if(next==="/" && next!=="*") type = 5;
							// Comment Multi Line
							else if(next==="*") type = 6;
						break;
						case "{": // Bracket Start
							if(prev!=="\\") stateObj.bracketCount++;
						break;
						case "}": // Bracket End
							if(prev!=="\\") stateObj.bracketCount--;
						break;
						case specialChar: // Special Character
							if(specialChar==="|" && prev!=="|" && next!=="|") positions.add(i);
							else positions.add(i);
						default:
						break;
					}
				break;
			}
		}
		if(type===1) throw new Error("SyntaxError: Unfinished String");
		if(type===2) throw new Error("SyntaxError: Unfinished Template Literal");
		if(tplLiteralCount!==0) throw new Error("SyntaxError: Unfinished Template Literal Expression");
		if(state[0]?.bracketCount>0) throw new Error("SyntaxError: Unfinished Closure");
		return positions;
	}
	
	/**
	 * Distinguish between '/' as a regex and '/' as division.
	 */
	isRegexPos(expr,index){
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
