"use strict";

const isTextNodeSolid = (()=>{
	let e=document.createElement('div'), tn=document.createTextNode('text'); e.appendChild(tn);
	return function isTextNodeSolid(data){ tn.data=data; return e.innerText.length>0; };
})();
const elementNodeType = document.ELEMENT_NODE;
const textNodeType = document.TEXT_NODE;

export class pluginParse {
	get name(){ return 'parse'; }
	
	constructor(scopeDom,instance){
		this.scopeDom = scopeDom;
		this.instance = instance;
		this.isElementLoaded = scopeDom.isElementLoaded;
		this.eventMap = new WeakMap(); // per element-set
		this.mutObsMap = new WeakMap(); // per element
		this.intObsMap = new WeakMap(); // per element
		this.stateMap = new WeakMap(); // per element
		this.allParseTextNodes = new WeakSet(); // only textNode
		this.elementChildExcludeText = new WeakSet(); // only child elements
		this.regexCache = new Map();
	}
	
	onConnect(plugInfo){
		let { element, attribs } = plugInfo;
		if(!element.isConnected) return;
		let parseAttrib;
		if(attribs?.size>0) for(let [attribName,attrib] of attribs){
			let { nameParts, nameKey, isDefault } = attrib;
			if(nameKey==='parse') parseAttrib = attrib;
		}
		if(!parseAttrib) return;
		this._setupParse(plugInfo,parseAttrib);
	}
	
	onDisconnect(plugInfo){
		let attrib, { element, attribs } = plugInfo;
		if(attribs?.size>0) for(let [n,a] of attribs) if(a.nameParts.length===1 && a.nameParts[0]==='parse'){ attrib=a; break; }
		if(!attrib) return;
		// Remove exclude
		if(this.elementChildExcludeText.has(element)) this.elementChildExcludeText.delete(element);
		// Remove event listeners - for element
		if(this.eventMap.has(element)){
			let set = this.eventMap.get(element);
			for(let removeEvent of set) removeEvent();
			this.eventMap.delete(element);
		}
		// Disconnect Mutation Observers - for element
		if(this.mutObsMap.has(element)){
			let mutObs = this.mutObsMap.get(element);
			if(mutObs){ this.mutObsMap.delete(element); mutObs.disconnect(); }
		}
		// Disconnect Intersection Observers - for element
		if(this.intObsMap.has(element)){
			let intObs = this.intObsMap.get(element);
			if(intObs){ this.intObsMap.delete(element); intObs.disconnect(); }
		}
		// Restore original values - for element
		if(!this.stateMap.has(element)) return;
		let state = this.stateMap.get(element);
		let { parseNodes, parseAttribsMap, options } = state;
		for(let [node,obj] of parseNodes) this._undoNodeParse(state,node);
		for(let [e,m] of parseAttribsMap) for(let [name,obj] of m) this._undoAttribParse(state,name);
		let { parseBindSafe, parseBindHTML } = options;
		if(parseBindSafe || parseBindHTML) this._undoBindParse(state,element);
		// Remove from Maps & Sets - for element-attribute
		this.stateMap.delete(element);
		// Normalise text nodes
		if(state.normalize) element.normalize = state.normalize;
		element.normalize();
	}
	
	_setupParse(plugInfo,attrib){
		let { element, elementScopeCtrl } = plugInfo;
		// Setup Options
		let attribOpts = this.instance.elementAttribOptionsWithDefaults(element,attrib);
		// Options
		let parseText = this._getAttribOption(plugInfo,attrib,attribOpts,'text',false,true,true); // $parse:text
		let parseTree = this._getAttribOption(plugInfo,attrib,attribOpts,'tree',false,true,true); // $parse:tree
		let onlyOnce = this._getAttribOption(plugInfo,attrib,attribOpts,'once',false,true,true); // $parse:once
		let updateEvent = this._getAttribOption(plugInfo,attrib,attribOpts,'update scope','$update',false,true); // $parse:update-scope='event', $emit('event')
		let updateDomEvent = this._getAttribOption(plugInfo,attrib,attribOpts,'update dom','$update',false,true); // $parse:update-dom='event', $emitDom('event')
		let onError = this._getAttribOption(plugInfo,attrib,attribOpts,'error','',false,true); // $parse:error
		let allowDom = this._getAttribOption(plugInfo,attrib,attribOpts,'allow dom',false,true,true); // $parse:allow-dom
		let visible = this._getAttribOption(plugInfo,attrib,attribOpts,'visible',false,true,true); // $parse:visible
		let defaultText = this._getAttribOption(plugInfo,attrib,attribOpts,'default text','...',false,true); // $parse:default-text
		let safeMode = this._getAttribOption(plugInfo,attrib,attribOpts,'safe',false,true,true); // $parse:once
		// Option: $parse:exclude
		let exclude = this._getAttribOption(plugInfo,attrib,attribOpts,'exclude',false,true,true); // $parse:exclude
		if(exclude.value) this.elementChildExcludeText.add(element);
		// Option: $parse:exp - Expression Regex
		let expRegex = /(\{\{(.*?)}})/g
		let expOpt = this._getAttribOption(plugInfo,attrib,attribOpts,'exp',null,false,false); // $parse:exp
		if(expOpt.value?.length>0){
			let { result:optFormatResult } = this.instance.elementExecExp(elementScopeCtrl,expOpt.value,null,{ silentHas:true, useReturn:true });
			if(typeof optFormatResult==='string' && this.regexCache.has(optFormatResult)) optFormatResult = this.regexCache.get(optFormatResult);
			if(typeof optFormatResult==='string'){
				var result = optFormatResult.replace(/[|\\{}()[\]^$+*?.]/g,'\\$&');
				let pos1 = result.indexOf('exp');
				if(pos1===-1){ console.warn('pluginParse: invalid format, expecting something like {{exp}}, found',optFormatResult,expOpt?.attribute,element); return false; }
				let start = result.substr(0,pos1);
				let end = result.substr(pos1+3);
				expRegex = new RegExp('('+start+'(.*?)'+end+')','g');
				let check = [...this.scopeDom.regexMatchAll(optFormatResult,expRegex)];
				if(!check || !check?.[0]){ console.warn('pluginParse: invalid format,',result,'('+start+'(.*?)'+end+')',expRegex,check,expOpt?.attribute,element); return false; }
				if(check?.[0]?.[1]!==optFormatResult){ console.warn('pluginParse: invalid format,',expRegex,check,expOpt?.attribute,element); return false; }
				if(check?.[0]?.[2]!=='exp'){ console.warn('pluginParse: invalid format, missing exp,',expRegex,check,expOpt?.attribute,element); return false; }
				this.regexCache.set(optFormatResult,expRegex);
			}
			else if(optFormatResult instanceof RegExp) expRegex = optFormatResult;
			else { console.warn('pluginParse: invalid result, expecting string or regex,',optFormatResult,expOpt?.attribute,element); return false; }
		}
		// Option: $parse:attrib-name
		let parseAttribsMap = new Map();
		let parseAttribNames = new Set();
		for(let [k,{ optionParts:optParts, value }] of attribOpts){
			if(optParts.length<2 || optParts[0]!=='attrib') continue;
			let name = optParts.slice(1).join('-');
			parseAttribNames.add(name);
			if(value?.length>0){
				let m = parseAttribsMap.get(element) || new Map();
				m.set(name,{ __proto__:null, exec:null, signalObs:null, exp:value, original:null });
				if(!parseAttribsMap.has(element)) parseAttribsMap.set(element,m);
			}
		}
		// Option: $parse:bind & $parse:bind-html - Parse Bind - Auto-Excludes if no tree or text on same element.
		let parseBindSafe = false, parseBindHTML = false;
		let bindSafe = this._getAttribOption(plugInfo,attrib,attribOpts,'bind',false,false,false); // $parse:bind
		let bindHTML = this._getAttribOption(plugInfo,attrib,attribOpts,'bind html',false,false,false); // $parse:bind-html
		if(!(parseTree.value && !parseTree.isDefault) && !(parseText.value && !parseText.isDefault)){
			if(bindSafe.value?.length>0) parseBindSafe = { __proto__:null, exec:null, signalObs:null, exp:bindSafe.value, original:element.textContent, ready:false };
			else if(bindHTML.value?.length>0) parseBindHTML = { __proto__:null, exec:null, signalObs:null, exp:bindHTML.value, original:element.innerHTML, ready:false };
			if(parseBindSafe || parseBindHTML) this.elementChildExcludeText.add(element);
		}
		// State
		let state = { __proto__:null,
			signalCtrl: elementScopeCtrl.ctrl.signalCtrl,
			element, normalize:null, parseNodes:new Map(), parseAttribNames, parseAttribsMap, nodesPending:false, parsePending:false, isVisible:false,
			options:{ __proto__:null,
				parseTree:parseTree.value, parseText:parseText.value, onlyOnce:onlyOnce.value, updateEvent:updateEvent.value, updateDomEvent:updateDomEvent.value,
				onError:onError.value, allowDomResult:allowDom.value, onVisible:visible.value, defaultText:defaultText.value,
				exclude:exclude.value, expRegex, parseBindSafe, parseBindHTML, safeMode:safeMode.value
			}
		};
		this.stateMap.set(element,state);
		// Disable normalize
		if(!state.normalize){
			state.normalize = element.normalize;
			element.normalize = this._disabledNormalize;
		}
		// Listen
		let triggerExec = this._runParseExpressions.bind(this,state);
		if(updateEvent.value?.length>0){ // $parse:update='event', $emit('event')
			this._registerEvent(element,elementScopeCtrl.ctrl.$on(updateEvent.value,triggerExec,{ __proto__:null, capture:false, passive:true },true));
		}
		if(updateDomEvent.value?.length>0){ // $parse:update-dom='event', $emitDom('event')
			this._registerEvent(element,elementScopeCtrl.$onDom(updateDomEvent.value,triggerExec,{ __proto__:null, capture:true, passive:true },true));
		}
		// Add $parse() to element & element context
		elementScopeCtrl.execContext.$parse = element.$parse = triggerExec;
		// Continue when ready
		this.instance.onReady(function onReadyPluginParse(){
			// Find & watch targets
			this._scanParseTargets(state);
			// Observe later nodes
			this._setupMutationObserver(state);
			// Observe visability
			if(visible.value) this._setupIntersectionObserver(state);
			// Run first parse
			this._runParseExpressions(state);
			// If more parsing is needed
			if(state.nodesPending) this._scanParseRunSafe(state);
		}.bind(this),false);
	}
	
	_getAttribOption(plugInfo,attrib,attribOpts,optName,defaultValue=null,trueOnEmpty=false,runExp=false){
		let { instance } = this;
		let { elementScopeCtrl } = plugInfo;
		let { isDefault, attribute, nameKey, nameParts, value } = attrib;
		let optValue = defaultValue, opt = attribOpts.get(optName)
		if(trueOnEmpty && (opt?.value==='' || opt?.value===null)) optValue = true;
		else if(runExp && opt?.value?.length>0){
			let { result } = instance.elementExecExp(elementScopeCtrl,opt.value,null,{ silentHas:true, useReturn:true });
			if(typeof result!==void 0) optValue = result;
		}
		else if(!runExp && opt?.value?.length>0) optValue = opt.value;
		return { __proto__:null, value:optValue, raw:opt?.value, attribOption:opt, isDefault };
	}
	
	_disabledNormalize(){ console.warn('This element has .normalize disabled while parse is being used.'); };
	
	_setupMutationObserver(state){
		let { element, parseNodes, options } = state;
		let { parseBindSafe, parseBindHTML } = options;
		if(parseBindSafe || parseBindHTML) return;
		if(this.mutObsMap.has(element)) return;
		let mutObs=new MutationObserver(function pluginParseMutationObserver(muts){
			let check = false;
			for(let m of muts){
				for(let e of m.addedNodes){
					if((e.nodeType!==textNodeType && e.nodeType!==elementNodeType) || e.shadowRoot || e.nodeName==='TEMPLATE' || e.nodeName==='SCRIPT' || e.nodeName==='STYLE') continue;
					check = true;
				}
				for(let e of m.removedNodes){
					if(e.nodeType===textNodeType && this.allParseTextNodes.has(e) && parseNodes.has(e)) this._undoNodeParse(state,e);
					if(this.elementChildExcludeText.has(e)) this.elementChildExcludeText.delete(e);
				}
			}
			if(check) this._scanParseRunSafe(state);
		}.bind(this));
		mutObs.observe(element,{ __proto__:null, subtree:!!options.parseTree, childList:true, attributes:false });
		this.mutObsMap.set(element,mutObs);
	}
	
	_setupIntersectionObserver(state){
		let { element, options } = state;
		let { onVisible } = options;
		if(!onVisible || this.intObsMap.has(element)) return;
		let fn = this._runParseExpressions.bind(this,state);
		let intObs=new IntersectionObserver(function pluginParseIntersectionObserver(ints){
			let check=false, prevVisible=state.isVisible;
			for(let int of ints){
				if(int.intersectionRatio>0){ if(!prevVisible){ state.isVisible=true; check=true; } }
				else { if(prevVisible){ state.isVisible=false; } }
			}
			if(check) this.scopeDom.animFrameHelper.onceRAF(state.element,'pluginParse-onVisible',fn);
		}.bind(this),{ __proto__:null, threshold:[0,0.05,0.5,0.95,1], rootMargin:"10px", });
		intObs.observe(element);
		this.intObsMap.set(element,intObs);
	}
	
	_scanParseRunSafe(state){
		this._scanParseTargets(state);
		if(!state.parsePending && !state.nodesPending) return; // Helps prevent infinite-check
		state.parsePending = false;
		this._runParseExpressions(state);
		// If document is still loading & there's an element mid-dom-construction
		if(state.nodesPending) this.scopeDom.animFrameHelper.onceRAF(state.element,'pluginParse-nodesPending',this._scanParseRunSafe.bind(this,state));
		state.nodesPending = false;
	}
	
	_registerEvent(element,removeEvent){
		if(!this.eventMap.has(element)) this.eventMap.set(element,new Set());
		this.eventMap.get(element).add(removeEvent);
	}
	
	_scanParseTargets(state){
		let targets = this._findTargets(state.element,state);
		this._parseTargets(state,targets);
	}
	
	_findTargets(eTarget,state,recursiveFind=false){
		let { parseNodes, parseAttribNames, parseAttribsMap, options } = state;
		let { parseTree, parseText, expRegex, parseBindSafe, parseBindHTML } = options;
		let nodes = new Set(), attribs = new Set();
		if(parseTree || parseText){
			for(let e of eTarget.childNodes){
				if(this.instance.isElementIgnored(e,false)) continue; // $ignore
				if(e.nodeType!==elementNodeType && e.nodeType!==textNodeType) continue;
				if(e.shadowRoot || e.nodeName==='TEMPLATE' || e.nodeName==='SCRIPT' || e.nodeName==='STYLE') continue;
				if(parseText && e.nodeType===textNodeType){
					if(parseNodes.has(e) || this.allParseTextNodes.has(e)) continue;
					if(!this.scopeDom.isElementLoaded(e)){ state.nodesPending=true; continue; }
					let isMatch = this.scopeDom.regexTest(e.data,expRegex);
					if(isMatch){
						nodes.add(e);
						state.parsePending = true;
					}
				}
				else if(parseTree && e?.childNodes?.length>0){
					if(this.elementChildExcludeText.has(e)) continue;
					// If element has $parse:exclude
					if(e.attributes?.length>0){
						let allElemAttribs = this.instance.elementAttribs(e,true,false), foundExclude = false;
						if(allElemAttribs) for(let [attribName,attrib] of allElemAttribs){
							let { nameParts } = attrib;
							if(nameParts.length!==1 || nameParts[0]!=='parse') continue;
							let opts = this.instance.elementAttribOptionsWithDefaults(e,attrib,true,false);
							if(opts.has('exclude') && opts.get('exclude').value===''){
								this.elementChildExcludeText.add(e);
								foundExclude = true;
								break;
							}
						}
						if(foundExclude) continue;
					}
					// Search child nodes
					let { nodes:nodes2, attribs:attribs2 } = this._findTargets(e,state,true);
					if(nodes2.size>0) nodes = nodes.union ? nodes.union(nodes2) : new Set([...nodes,...nodes2]);
					if(attribs2.size>0) attribs = attribs.union ? attribs.union(attribs2) : new Set([...attribs,...attribs2]);
				}
			}
		}
		if(!recursiveFind){
			if(parseAttribNames.size>0){
				if(!this.scopeDom.isElementLoaded(eTarget)) state.nodesPending=true;
				for(let { name, value } of eTarget.attributes){
					if(!parseAttribNames.has(name) || !this.scopeDom.regexTest(value,expRegex)) continue;
					if(parseAttribsMap.get(eTarget)?.has(name)) continue;
					attribs.add({ __proto__:null, element:eTarget, name, value });
					state.parsePending = true;
				}
			}
			if(parseBindSafe && !parseBindSafe.ready){
				if(!this.scopeDom.isElementLoaded(eTarget)) state.nodesPending=true;
				else { parseBindSafe.ready=true; state.parsePending=true; }
			}
			else if(parseBindHTML && !parseBindHTML.ready){
				if(!this.scopeDom.isElementLoaded(eTarget)) state.nodesPending=true;
				else { parseBindHTML.ready=true; state.parsePending=true; }
			}
		}
		return { nodes, attribs };
	}
	
	__regexMatchExp(str,regex){
		let match, matches=[]; regex.lastIndex=0;
		while(match=regex.exec(str)) matches.push({ expOuter:match[1], expInner:match[2], regexIndex:match.index });
		return matches;
	}
	_parseTargets(state,targets){
		let { parseNodes, parseAttribsMap, options } = state;
		let { expRegex } = options;
		let { nodes:pendingNodes, attribs:pendingAttribs } = targets;
		// Parse text nodes
		if(pendingNodes.size>0){
			for(let e of pendingNodes){
				let text=e.data, textLen=text.length, matches=this.__regexMatchExp(text,expRegex), index=0, nodes=[];
				for(let { expOuter, expInner, regexIndex } of matches){
					let parseNode, start=index, pos=regexIndex, end=regexIndex+expOuter.length;
					index = end;
					// If text node is only expression, re-use same node
					if(start===0 && pos===0 && index===textLen) parseNode = e;
					// Otherwise split into multiple nodes
					else {
						let beforeStr = text.substr(start,pos-start);
						if(beforeStr.length>0) nodes.push(document.createTextNode(beforeStr));
						parseNode = document.createTextNode(expOuter);
						nodes.push(parseNode);
					}
					parseNodes.set(parseNode,{ __proto__:null, node:parseNode, exec:null, signalObs:null, exp:expInner, original:expOuter, anchor:null, updateIndex:0, lastResult:expOuter });
					this.allParseTextNodes.add(parseNode);
				}
				if(nodes.length>0){
					if(index<textLen) nodes.push(document.createTextNode(text.substr(index)));
					const fragment = document.createDocumentFragment();
					for(let n of nodes){
						fragment.appendChild(n);
						this.instance.elementScopeSetAlias(n,e);
					}
					e.replaceWith(fragment);
				}
			}
		}
		// Parse attribute values
		if(pendingAttribs.size>0){
			for(let { element:e, name, value:text } of pendingAttribs){
				let matches=this.__regexMatchExp(text,expRegex), index=0, expArr=[];
				for(let { expOuter, expInner, regexIndex } of matches){
					let start=index, pos=regexIndex, end=regexIndex+expOuter.length;
					index = end;
					let beforeStr = text.substr(start,pos-start);
					if(beforeStr.length>0) expArr.push(JSON.stringify(beforeStr));
					expArr.push('('+expInner+')');
				}
				if(index<text.length) expArr.push(JSON.stringify(text.substr(index)));
				if(!parseAttribsMap.has(e)) parseAttribsMap.set(e,new Map());
				let exp, attribMap = parseAttribsMap.get(e);
				if(expArr.length===1) exp = expArr[0];
				else exp = `[${expArr.join(',')}].join('')`;
				if(!attribMap.has(name)) attribMap.set(name,{ __proto__:null, exec:null, signalObs:null, exp, original:text, updateIndex:0 });
			}
		}
	}
	
	_undoNodeParse(state,node){
		let { parseNodes } = state;
		let obj = parseNodes.get(node);
		if(obj){
			if(obj.skipUndo){ delete obj.skipUndo; return; }
			if(obj.anchor && obj.anchor.isConnected) return;
			node.data = obj.original;
			obj.lastResult = obj.original;
			if(obj.anchor && obj.anchor.parentNode) obj.anchor.remove();
			obj.signalObs?.clear(); obj.signalObs = obj.exec = null;
		}
		if(this.allParseTextNodes.has(node)) this.allParseTextNodes.delete(node);
		parseNodes.delete(node);
	}
	_undoAttribParse(state,name){
		let { element, parseAttribsMap } = state;
		let obj = parseAttribsMap.get(element)?.get(name);
		if(obj && (obj.original===void 0 || obj.original===null)) element.removeAttribute(name);
		else if(obj) element.setAttribute(name,obj.original);
		if(obj){
			parseAttribsMap.get(element)?.delete(name);
			obj.signalObs?.clear(); obj.signalObs = obj.exec = null;
		}
	}
	_undoBindParse(state,element){
		let { parseBindSafe, parseBindHTML } = state.options;
		if(parseBindHTML){
			element.innerHTML = parseBindHTML.original;
			parseBindHTML.signalObs?.clear(); parseBindHTML.signalObs = parseBindHTML.exec = null;
		}
		else if(parseBindSafe){
			element.textContent = parseBindSafe.original;
			parseBindSafe.signalObs?.clear(); parseBindSafe.signalObs = parseBindSafe.exec = null;
		}
	}
	
	_execExpression(element,node,exp,signalObs){
		let eCtrl = this.instance.elementScopeCtrl(node);
		let exec = this.instance.elementExecExp(eCtrl,exp,{ $node:node, $expression:exp, $parseRoot:element },{ silentHas:true, useReturn:true, run:false });
		if(signalObs) exec.runFn = signalObs.wrapRecorder(exec.runFn);
		return exec;
	}
	
	_runParseExpressions(state){
		let { signalCtrl, element, parseNodes, parseAttribsMap, isVisible, options } = state;
		let { onlyOnce, parseBindSafe, parseBindHTML, onVisible } = options;
		let self = this;
		// Text Nodes
		for(let [n,obj] of parseNodes){
			let result, { node, exp, exec, signalObs, comment, updateIndex } = obj;
			if(!node.isConnected && !(comment && comment.isConnected)){ this._undoNodeParse(state,node); continue; }
			if(exec && onlyOnce) continue;
			if(onVisible && !isVisible){ if(updateIndex===0) result=options.defaultText; else continue; }
			else{
				if(!exec){
					signalObs = obj.signalObs = signalCtrl.createObserver();
					exec = obj.exec = this._execExpression(element,node,exp,signalObs);
					signalObs.addListener(function parseTextNode_signalObserver(){
						let updateIndex = obj.updateIndex;
						self.scopeDom.animFrameHelper.onceRAF(node,signalObs,function parseTextNode_signalObserver_RAF(){
							if(obj.updateIndex===updateIndex) self._updateTextNode(node,exec.runFn(),obj,state,updateIndex,signalObs);
						});
					});
				}
				result = exec.runFn();
			}
			this._updateTextNode(node,result,obj,state,updateIndex,signalObs);
		}
		// Element Attributes
		for(let [node,attribMap] of parseAttribsMap){
			if(!node.isConnected){ for(let [name,obj] of attribMap){ this._undoAttribParse(state,name); } continue; }
			for(let [name,obj] of attribMap){
				let { exp, exec, signalObs, updateIndex } = obj;
				if(exec && onlyOnce) continue;
				if(onVisible && !isVisible) continue;
				if(!exec){
					signalObs = obj.signalObs = signalCtrl.createObserver();
					exec = obj.exec = this._execExpression(element,node,exp,signalObs);
					signalObs.addListener(function parseAttribs_signalObserver(){
						let updateIndex = obj.updateIndex;
						self.scopeDom.animFrameHelper.onceRAF(node,signalObs,function parseAttribs_signalObserver_RAF(){
							if(obj.updateIndex===updateIndex) self._updateAttribute(node,name,exec.runFn(),obj,state,updateIndex,signalObs);
						});
					});
				}
				this._updateAttribute(node,name,exec.runFn(),obj,state,updateIndex,signalObs);
			}
		}
		// Bind-Safe attribute
		if(parseBindSafe && parseBindSafe.ready){
			for(let { exec, exp, signalObs, updateIndex } of [parseBindSafe]){
				if(exec && onlyOnce) continue;
				if(onVisible && !isVisible) continue;
				if(!exec){
					signalObs = parseBindSafe.signalObs = signalCtrl.createObserver();
					exec = parseBindSafe.exec = this._execExpression(element,element,exp,signalObs);
					signalObs.addListener(function parseBindSafe_signalObserver(){
						let updateIndex = parseBindSafe.updateIndex;
						self.scopeDom.animFrameHelper.onceRAF(element,signalObs,function parseBindSafe_signalObserver_RAF(){
							if(parseBindSafe.updateIndex===updateIndex) self._updateBind(element,false,exec.runFn(),parseBindSafe,state,updateIndex,signalObs);
						});
					});
				}
				this._updateBind(element,false,exec.runFn(),parseBindSafe,state,updateIndex,signalObs);
			}
		}
		// Bind-HTML attribute
		else if(parseBindHTML && parseBindHTML.ready){
			for(let { exec, exp, signalObs, updateIndex } of [parseBindHTML]){
				if(exec && onlyOnce) continue;
				if(onVisible && !isVisible) continue;
				if(!exec){
					signalObs = parseBindHTML.signalObs = signalCtrl.createObserver();
					exec = parseBindHTML.exec = this._execExpression(element,element,exp,signalObs);
					signalObs.addListener(function parseBindHTML_signalObserver(){
						let updateIndex = parseBindHTML.updateIndex;
						self.scopeDom.animFrameHelper.onceRAF(element,signalObs,function parseBindHTML_signalObserver_RAF(){
							if(parseBindHTML.updateIndex===updateIndex) self._updateBind(element,true,exec.runFn(),parseBindHTML,state,updateIndex,signalObs);
						});
					});
				}
				this._updateBind(element,true,exec.runFn(),parseBindHTML,state,updateIndex,signalObs);
			}
		}
	}
	
	_updateTextNode(node,result,obj,state,updateIndex,signalObs){
		let { options } = state;
		if(result instanceof Promise){
			if(updateIndex===0){
				this._updateTextNode(node,options.defaultText,obj,state,updateIndex,signalObs);
				updateIndex = obj.updateIndex;
			}
			let onSuccess = (result)=>this._updateTextNode(node,result,obj,state,updateIndex,signalObs);
			let onError = ()=>this._updateTextNode(node,options.onError,obj,state,updateIndex,signalObs);
			this.scopeDom.animFrameHelper.promiseToRAF(result,onSuccess,onError);
			return;
		}
		// Ignore old calls
		if(obj.updateIndex>updateIndex) return;
		obj.updateIndex++;
		// Result Types
		result = this.scopeDom.resolveSignal(result,signalObs);
		if(result instanceof Error) result = options.onError;
		if(result instanceof Node){
			let validNode = true;
			for(let e=node; e; e=e.parentNode) if(e===result){ validNode=false; break; }
			if(validNode) result = result.textContent;
			else result = options.onError;
		}
		result = (result===null || result===void 0) ? '' : ''+result;
		// Unchanged result
		if(obj.lastResult===result) return;
		obj.lastResult = result;
		// If textnode is not visible, some browsers (FF) remove it, so anchor it with comment
		let visible = isTextNodeSolid(result);
		if(!visible && !obj.anchor){
			obj.anchor = document.createComment(' Parse-Anchor: '+obj.original+' '); //obj.anchor.$parseTextNode=node;
			this.instance.elementScopeSetAlias(obj.anchor,node);
			node.parentNode.insertBefore(obj.anchor,node.nextSibling);
		}
		let current = node.data;
		// Prevent recursion
		if(options.safeMode){
			if(result.length>current.length && result.indexOf(current)!==-1){ obj.foundWithin=(obj.foundWithin||0)+1; if(obj.foundWithin>5)return; }
			else obj.foundWithin = 0;
		}
		// Update Result
		if(current!==result) node.data = result;
		if(obj.anchor && (!obj.anchor.isConnected || node.nextSibling!==obj.anchor)){ obj.skipUndo=true; obj.anchor.parentNode.insertBefore(node,obj.anchor); }
	}
	
	_updateAttribute(element,attribute,result,obj,state,updateIndex,signalObs){
		let { options } = state;
		result = this.scopeDom.resolveSignal(result,signalObs);
		if(result instanceof Promise){
			let onSuccess = (result)=>this._updateAttribute(element,attribute,result,obj,state,updateIndex,signalObs);
			let onError = ()=>this._updateAttribute(element,attribute,options.onError,obj,state,updateIndex,signalObs);
			this.scopeDom.animFrameHelper.promiseToRAF(result,onSuccess,onError);
			return;
		}
		// Ignore old calls
		if(obj.updateIndex>updateIndex) return;
		obj.updateIndex++;
		// Result Types
		if(result instanceof Error) element.setAttribute(attribute,options.onError);
		else if((result===null || result===void 0) && element.hasAttribute(attribute)) element.removeAttribute(attribute);
		else if(result?.length>=0){ result=''+result; if(element.getAttribute(attribute)!==result) element.setAttribute(attribute,result); }
	}
	
	_updateBind(element,isHTML,result,obj,state,updateIndex,signalObs){
		let { options } = state;
		if(result instanceof Promise){
			let onSuccess = (result)=>this._updateBind(element,isHTML,result,obj,state,updateIndex,signalObs);
			let onError = ()=>this._updateBind(element,isHTML,options.onError,obj,state,updateIndex,signalObs);
			this.scopeDom.animFrameHelper.promiseToRAF(result,onSuccess,onError);
			return;
		}
		// Ignore old calls
		if(obj.updateIndex>updateIndex) return;
		obj.updateIndex++;
		// Result Types
		result = this.scopeDom.resolveSignal(result,signalObs);
		if(result instanceof Error) result = options.onError;
		if(result instanceof NodeList){ let e=document.createDocumentFragment(); for(let n of [...result])e.appendChild(n); result=e; }
		else if(result instanceof HTMLCollection){ let e=document.createDocumentFragment(); for(let n of [...result])e.appendChild(n); result=e; }
		if(result instanceof Node){
			let validNode = true;
			for(let e=element; e; e=e.parentNode) if(e===result){ validNode=false; break; }
			if(!validNode) result = options.onError;
			else if(!options.allowDomResult) result = isHTML?(result.innerHTML||result.textContent):result.textContent;
			else { element.textContent=''; element.appendChild(result); return; }
		}
		result = (result===null || result===void 0) ? '' : ''+result;
		let current = isHTML ? element.innerHTML : element.textContent;
		// Prevent recursion
		if(options.safeMode){
			if(result.length>current.length && result.indexOf(current)!==-1){ obj.foundWithin=(obj.foundWithin||0)+1; if(obj.foundWithin>5)return; }
			else obj.foundWithin = 0;
		}
		// Update Result
		if(current!==result){ if(isHTML) element.innerHTML=result; else element.textContent=result; }
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.scopeDom?.pluginAdd?.(pluginParse) || ((win.scopeDomPlugins=win.scopeDomPlugins||{}).pluginParse=pluginParse);
