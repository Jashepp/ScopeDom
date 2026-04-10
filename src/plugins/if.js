"use strict";

const textNodeType = document.TEXT_NODE;

const matchCasePromiseWaitSymbol = Symbol('pluginIf-matchCase-promise-wait');
const matchCasePromiseResultSymbol = Symbol('pluginIf-matchCase-promise-result');

const matchCaseOperatorSymbol = Symbol('pluginIf-matchCaseScope-operator');
const matchCaseOperatorFn = (op,arr)=>{
	let fn=_=>arr; fn[matchCaseOperatorSymbol]=op; return fn;
};
const matchCaseScope = Object.freeze({
	_(v){ return true; },
	_or(...arr){ return matchCaseOperatorFn('or',arr); },
	_and(...arr){ return matchCaseOperatorFn('and',arr); },
	_not(...arr){ return matchCaseOperatorFn('not',arr); },
});

export class pluginIf {
	get name(){ return 'if'; }
	
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.isElementLoaded = ScopeDom.isElementLoaded;
		this.eventMap = new WeakMap(); // element, set (removeEvent cb)
		this.stateMap = new WeakMap(); // element, state
	}
	
	onConnect(plugInfo){
		let { instance, isElementLoaded } = this;
		let { element, attribs } = plugInfo;
		if(!element.isConnected) return;
		if(element.nodeName==='TEMPLATE' && !isElementLoaded(element)){ instance.onElementLoaded(element,this.onConnect.bind(this,plugInfo)); return; }
		let ifAttribNames = ['if','if else','if match','if case'];
		let ifAttribs=new Map(), repeatAttrib, buildAttrib;
		if(attribs?.size>0) for(let [attribName,attrib] of attribs){
			let { nameKey } = attrib;
			if(ifAttribNames.indexOf(nameKey)!==-1) ifAttribs.set(nameKey,attrib);
			else if(nameKey==='repeat') repeatAttrib = attrib;
			else if(nameKey==='build') buildAttrib = attrib;
		}
		if(ifAttribs.size===0) return;
		if(repeatAttrib && element.nodeName==='TEMPLATE') this._moveAttrib(plugInfo,repeatAttrib,'default repeat');
		if(buildAttrib && element.nodeName==='TEMPLATE') this._moveAttrib(plugInfo,buildAttrib,'default build');
		this._setupIf(plugInfo,ifAttribs);
	}
	
	_moveAttrib(plugInfo,targetAttrib,defaultAttribName){
		let { element, attribs } = plugInfo;
		if(targetAttrib.$pluginIfMoved) return;
		targetAttrib.$pluginIfMoved = true;
		// Move template->nodes to template->template->nodes
		element.parentNode.insertBefore(document.createComment(' If-Move: '+element.cloneNode(false).outerHTML+' '),element);
		let template = document.createElement('template');
		template.content.appendChild(element.content.cloneNode(true));
		for(let e of [...element.content.childNodes]) element.content.removeChild(e);
		element.content.appendChild(template);
		// Move attribs to inner template
		element.removeAttribute(targetAttrib.attribute);
		if(targetAttrib.value!==null) this.ScopeDom.setAttribute(template,targetAttrib.attribute,targetAttrib.value);
		for(let [n,opt] of targetAttrib.options){
			if(opt.attribute) element.removeAttribute(opt.attribute);
			if(opt.attribute && !opt.isDefault && opt.value!==null) this.ScopeDom.setAttribute(template,opt.attribute,opt.value);
		}
		if(attribs.has(defaultAttribName)){
			let defaultRepeat = attribs.get(defaultAttribName);
			if(defaultRepeat.value!==null) this.ScopeDom.setAttribute(template,defaultRepeat.attribute,defaultRepeat.value);
			for(let [n,opt] of defaultRepeat.options){
				if(opt.attribute) element.removeAttribute(opt.attribute);
				if(opt.attribute && opt.value!==null && !template.hasAttribute(opt.attribute)) this.ScopeDom.setAttribute(template,opt.attribute,opt.value);
			}
		}
	}
	
	onDisconnect(plugInfo,fakeDC=false){
		let { element, elementScopeCtrl, attribs } = plugInfo;
		// Get State
		let state = this.stateMap.get(element);
		if(!state) return;
		let removeState=true, removeEvents=true;
		let { isOnlyMatch, anchor, defaultDisplay, isTemplate, tplAnchorStart, tplAnchorEnd } = state;
		let anchorDC = (element===anchor || element===tplAnchorStart || element===tplAnchorEnd);
		if(anchorDC) element = state.element;
		let ranOnce = this._hasRanOnce(state);
		if(!isOnlyMatch && !isTemplate){
			// Anchor disconnect
			if(!ranOnce && anchorDC && element.isConnected) return;
			// DOM mode: only anchor is connected, keep state & events
			if(!ranOnce && !element.isConnected && anchor && anchor.isConnected) return;
			// DOM & Style mode: ran only once
			if(ranOnce){
				if(anchor && anchor.$pluginIfElement){
					anchor.data = ' (Removed)'+anchor.data;
					anchor.$pluginIfElement = null;
				}
				if(!fakeDC && defaultDisplay!==null){
					element.style.display = defaultDisplay;
				}
			}
			// DOM & Style mode: If element is not connected, with style
			if(!element.isConnected && defaultDisplay!==null){
				element.style.display = defaultDisplay;
			}
			// DOM mode: If element & anchor is not connected (disconnected by something else)
			if(!element.isConnected && anchor && !anchor.isConnected){
				if(anchor.parentNode || anchor.previousSibling || anchor.nextSibling) anchor.replaceWith(element);
			}
		}
		// Template mode
		if(!isOnlyMatch && isTemplate && !element.isConnected){
			if(tplAnchorStart && tplAnchorEnd){
				if(tplAnchorStart.parentNode && tplAnchorEnd.parentNode && tplAnchorStart.parentNode===tplAnchorEnd.parentNode){
					let endAfterStart = false;
					for(let e=tplAnchorStart.nextSibling; e; e=e.nextSibling) if(e===tplAnchorEnd){ endAfterStart=true; break; }
					if(endAfterStart) for(let e=tplAnchorStart.nextSibling; e && e!==tplAnchorEnd; e=e.nextSibling) e.remove();
				}
				else if(state.tplNodes) for(let n of state.tplNodes) n.parentNode?.removeChild(n);
				tplAnchorStart.parentNode?.removeChild(tplAnchorStart);
				tplAnchorEnd.parentNode?.removeChild(tplAnchorEnd);
				anchor?.parentNode?.removeChild(anchor);
			}
			state.tplNodes = state.tplAnchorStart = state.tplAnchorEnd = state.tplDefaultDisplay = null;
		}
		// Skip rest if main element is connected
		if(element.isConnected) removeState = removeEvents = false;
		// Remove State
		if(removeState){
			if(this.stateMap.has(element)) this.stateMap.delete(element);
			if(anchor && this.stateMap.has(anchor)) this.stateMap.delete(anchor);
			if(tplAnchorStart && this.stateMap.has(tplAnchorStart)) this.stateMap.delete(tplAnchorStart);
			if(tplAnchorEnd && this.stateMap.has(tplAnchorEnd)) this.stateMap.delete(tplAnchorEnd);
		}
		// Remove event listeners - for element
		if(removeEvents && this.eventMap.has(element)){
			let set = this.eventMap.get(element);
			for(let removeEvent of set) removeEvent();
			this.eventMap.delete(element);
		}
	}
	
	_setupIf(plugInfo,ifAttribs){
		let { instance } = this;
		let { element, elementScopeCtrl } = plugInfo;
		let isTemplate = (element.nodeName==='TEMPLATE');
		// Skip when existing state
		if(this.stateMap.has(element)) return;
		// Skip empty template
		if(isTemplate && !(element.content?.childNodes?.length>0)) return console.warn("pluginIf: template has no content");
		// Value / Expression
		let exp = null, expAttrib = null;
		for(let [nameKey,attrib] of ifAttribs){
			if(nameKey==='if' || nameKey==='if else' || nameKey==='if case'){
				if(attrib.value?.length>0){ exp = attrib.value; expAttrib = attrib; }
				if(expAttrib===null) expAttrib = attrib;
			}
		}
		for(let [nameKey,attrib] of ifAttribs){
			if(nameKey==='if' || nameKey==='if else' || nameKey==='if case'){
				if(exp===null && !(attrib.value?.length>0)){
					let value = attrib.value = instance.elementAttribFallbackOptionValue(attrib,['once','dom']);
					if(value?.length>0){ exp = value; expAttrib = attrib; }
				}
			}
			if(nameKey==='if match'){
				attrib.value = instance.elementAttribFallbackOptionValue(attrib,['once']);
			}
		}
		// Options
		let attribOpts = new Map(), matchOpts = new Map();
		for(let [nameKey,attrib] of ifAttribs){
			if(nameKey==='if' || nameKey==='if else' || nameKey==='if case'){
				let options = instance.elementAttribOptionsWithDefaults(element,attrib);
				if(options.size>0) attribOpts = new Map([...attribOpts,...options]);
			}
			if(nameKey==='if match'){
				matchOpts = instance.elementAttribOptionsWithDefaults(element,attrib);
			}
		}
		// Attrib Values
		let ifValue = ifAttribs.has('if') ? ifAttribs.get('if').value : false,
		ifElseValue = ifAttribs.has('if else') ? ifAttribs.get('if else').value : false,
		ifMatchValue = ifAttribs.has('if match') ? ifAttribs.get('if match').value : false,
		ifCaseValue = ifAttribs.has('if case') ? ifAttribs.get('if case').value : false;
		let isOnlyMatch = ((ifMatchValue?.length>0 || ifMatchValue===null) && !expAttrib);
		// Options
		let onlyOnce = instance.elementAttribParseOption(element,attribOpts,'once',{ default:false, emptyTrue:true, runExp:true }); // $if:once
		let domRemove = instance.elementAttribParseOption(element,attribOpts,'dom',{ default:false, emptyTrue:true, runExp:true }); // $if:dom or  $if:dom='exp' - same as $if='exp' $if:dom
		let updateEvent = instance.elementAttribParseOption(element,attribOpts,'update scope',{ default:'$update', emptyTrue:false, runExp:true }).value; // $if:update-scope='event', $emit('event')
		let updateDomEvent = instance.elementAttribParseOption(element,attribOpts,'update dom',{ default:'$update', emptyTrue:false, runExp:true }).value; // $if:update-dom='event', $emitDom('event')
		let onShowEvent = instance.elementAttribParseOption(element,attribOpts,'on show',{ default:null, emptyTrue:false, runExp:false }).value; // $if:on-show='exp'
		let onHideEvent = instance.elementAttribParseOption(element,attribOpts,'on hide',{ default:null, emptyTrue:false, runExp:false }).value; // $if:on-hide='exp'
		let defaultValue = instance.elementAttribParseOption(element,attribOpts,'default',{ default:false, emptyTrue:false, runExp:true }).value; // $if:default='true' (eg, promise)
		// State
		onlyOnce=(onlyOnce.value===true); domRemove=(domRemove.value===true); //domOnce=(domOnce.value===true);
		let state = { __proto__:null,
			signalCtrl: elementScopeCtrl.ctrl.signalCtrl, signalObs:null,
			element, isOnlyMatch, ifValue, ifElseValue, ifMatchValue, ifCaseValue, matchOpts, depList:null,
			options:{ __proto__:null, onlyOnce, domRemove, onShowEvent, onHideEvent, defaultValue },
			showing:null, exec:null, execMatch:null, anchor:null, defaultDisplay:null, onShowExec:null, onHideExec:null, updateIndex:0,
			isTemplate, tplNodes:null, tplAnchorStart:null, tplAnchorEnd:null, tplDefaultDisplay:null,
		};
		if(!this.stateMap.has(element)) this.stateMap.set(element,state);
		// Skip if only if-match (after state is set)
		if(isOnlyMatch) return;
		// Trigger Exec
		let triggerExec = this._runIfExpressions.bind(this,plugInfo,expAttrib,state,exp);
		// Add $if() to element & element context
		elementScopeCtrl.execContext.$if = element.$if = triggerExec;
		// Register Events
		if(updateEvent?.length>0) this._registerEvent(element,elementScopeCtrl.ctrl.$on(updateEvent,triggerExec,{ __proto__:null, capture:false, passive:true },true));
		if(updateDomEvent?.length>0) this._registerEvent(element,elementScopeCtrl.$onDom(updateDomEvent,triggerExec,{ __proto__:null, capture:true, passive:true },true));
		// Continue when ready
		instance.onReady(function onReadyPluginIf(){
			this._runIfExpressions(plugInfo,expAttrib,state,exp);
		}.bind(this),false);
	}
	
	_registerEvent(element,removeEvent){
		if(!this.eventMap.has(element)) this.eventMap.set(element,new Set());
		this.eventMap.get(element).add(removeEvent);
	}
	
	
	_hasRanOnce(state){
		let { exec, anchor, defaultDisplay, options:{ onlyOnce, domRemove } } = state;
		return (onlyOnce && exec);
	}
	_execExpression(plugInfo,exp,useReturn=true,extra=null,signalObs=null){
		if(!(exp?.length>0)) return null;
		let exec = this.instance.elementExecExp(plugInfo.elementScopeCtrl,exp,{ __proto__:null, $expression:exp, ...extra },{ silentHas:true, useReturn, run:false });
		if(signalObs) exec.runFn = signalObs.wrapRecorder(exec.runFn);
		return exec;
	}
	_runIfExpressions(plugInfo,attrib,state,exp,runMatch=true,updateOthers=false){
		let { instance, isElementLoaded } = this;
		let { element, elementScopeCtrl, attribs } = plugInfo;
		let { signalObs, ifValue, ifElseValue, ifMatchValue, ifCaseValue, options, depList, showing:wasShowing, exec, anchor, updateIndex, isTemplate } = state;
		let { onShowEvent, onHideEvent } = options;
		if(!this.stateMap.has(element)) return;
		if(this._hasRanOnce(state)) return;
		runMatch = runMatch!==false;
		let result = null;
		// Specified or Empty if-else or if-case
		if(ifElseValue?.length>0 || ifElseValue===null || ifCaseValue?.length>0 || ifCaseValue===null){
			if(!depList){
				depList = new Set();
				// Build list of dependant if states
				for(let e=element.previousSibling; e; e=e.previousSibling){
					let isEl=e instanceof Element, eState=this.stateMap.get(e);
					if(!eState && !isEl) continue;
					if(!eState && isEl) break;
					if(eState){
						if(eState.ifElseValue===null || eState.ifCaseValue===null) break; // Empty if-else or if-case
						depList.add(eState);
						if(eState.ifValue?.length>0 || eState.ifMatchValue?.length>0) break; // Specified if or if-match
						if(e===eState.tplAnchorEnd) e = eState.tplAnchorStart;
					}
				}
				state.depList = depList;
			}
			// Check if states
			for(let s of depList) if(s.exec && s.showing){ result=false; break; }
			if((ifElseValue===null || ifCaseValue===null) && result===null){ result = true; } // Empty if-else or if-case
		}
		// Build Exec for On Show / On Hide
		if(onShowEvent?.length>0 && !state.onShowExec) state.onShowExec = this._execExpression(plugInfo,onShowEvent,false);
		if(onHideEvent?.length>0 && !state.onHideExec) state.onHideExec = this._execExpression(plugInfo,onHideEvent,false);
		// Build / Run Expression
		if(result===null){
			let execExtra = null;
			if(exp?.length>0 && ifCaseValue?.length>0 && ifCaseValue===exp) execExtra = matchCaseScope;
			if(!signalObs){
				signalObs = state.signalObs = (signalObs || state.signalCtrl.createObserver());
				let self=this; signalObs.addListener(function pluginIf_signalObserver(){
					let updateIndex = state.updateIndex;
					self.ScopeDom.animFrameHelper.onceRAF(element,signalObs,function pluginIf_signalObserver_RAF(){
						if(state.updateIndex!==updateIndex) return;
						signalObs.clearSignals();
						self._runIfExpressions(plugInfo,attrib,state,exp,runMatch,true);
					});
				});
			}
			if(!exec) exec = state.exec = this._execExpression(plugInfo,exp,true,execExtra,signalObs);
			result = element.$ifResult = exec.runFn();
		}
		this._handleResult(plugInfo,attrib,state,exp,updateIndex,runMatch,updateOthers,result);
	}
	
	_handleResult(plugInfo,attrib,state,exp,updateIndex,runMatch,updateOthers,result){
		let { signalObs, ifValue, ifElseValue, ifMatchValue, ifCaseValue, isTemplate, execMatch, options:{ matchOnce, defaultValue } } = state;
		// Ignore old results
		if(state.updateIndex>updateIndex) return;
		// Resolve Signal
		result = this.ScopeDom.resolveSignal(result,signalObs);
		// If result is promise, use default & handleResult when settled
		if(result instanceof Promise){
			// Fallback / Default Value
			this._handleResult(plugInfo,attrib,state,exp,updateIndex,runMatch,false,defaultValue);
			updateIndex = state.updateIndex;
			// Handle Result
			this.ScopeDom.animFrameHelper.promiseToRAF(result,this._handleResult.bind(this,plugInfo,attrib,state,exp,updateIndex,false,true));
			return;
		}
		// force updateOthers if match result is a promise
		if(!updateOthers && execMatch?.result instanceof Promise && Object.hasOwn(execMatch.result,matchCasePromiseResultSymbol)) updateOthers = true;
		// if updateOthers, check depList
		if(updateOthers && state.depList) for(let eState of state.depList) if(eState.showing){ result=false; ifElseValue=false; ifCaseValue=false; break; }
		// Handle if-match & if-case
		if(ifCaseValue?.length>0 && ifCaseValue===exp){
			let ifMatch = null, matchElement = state.element, matchResult = null, matchOpts = new Map();
			if(!execMatch && state.depList) for(let eState of [state,...state.depList]){
				if(!execMatch && eState.execMatch) execMatch = state.execMatch = eState.execMatch;
				if(eState.ifMatchValue?.length>0){
					ifMatch = eState.ifMatchValue;
					matchElement = eState.element;
					if(state.matchOpts.size>0) matchOpts = new Map([...matchOpts,...state.matchOpts]);
				}
			}
			let matchOnce = this.instance.elementAttribParseOption(matchElement,matchOpts,'once',{ default:false, emptyTrue:true, runExp:true }).value; // $if-match:once
			let firstRun = false;
			if(!execMatch){
				firstRun = true;
				if(ifMatch===null) ifMatch = `this`;
				execMatch = state.execMatch = this.instance.elementExecExp(this.instance.elementScopeCtrl(matchElement),ifMatch,{ __proto__:null, $expression:ifMatch },{ silentHas:true, useReturn:true, run:false, fnThis:null }); // fnThis:null sets 'this' as proxy
				if(signalObs) execMatch.runFn = signalObs.wrapRecorder(execMatch.runFn);
			}
			matchResult = execMatch.result;
			// Resolve Signal
			execMatch.result = this.ScopeDom.resolveSignal(execMatch.result,signalObs);
			// Resolve Promise
			if(execMatch.result instanceof Promise && Object.hasOwn(execMatch.result,matchCasePromiseResultSymbol)) matchResult = execMatch.result[matchCasePromiseResultSymbol];
			if(execMatch.result instanceof Promise && execMatch.result?.[matchCasePromiseWaitSymbol]) matchResult = defaultValue;
			// Run if needed
			else if(firstRun || (runMatch!==false && !matchOnce)){
				// console.log({ firstRun, runMatch, matchOnce });
				matchResult = execMatch.result = execMatch.runFn();
				// Resolve Signal
				execMatch.result = this.ScopeDom.resolveSignal(execMatch.result,signalObs);
				// Resolve Promise
				if(execMatch.result instanceof Promise && Object.hasOwn(execMatch.result,matchCasePromiseResultSymbol)) matchResult = execMatch.result[matchCasePromiseResultSymbol];
				else if(execMatch.result instanceof Promise && execMatch.result?.[matchCasePromiseWaitSymbol]) matchResult = defaultValue;
				else if(execMatch.result instanceof Promise){
					matchResult = defaultValue;
					execMatch.result[matchCasePromiseWaitSymbol] = true;
					this.ScopeDom.animFrameHelper.promiseToRAF(execMatch.result,(pResult)=>{
						execMatch.result[matchCasePromiseWaitSymbol] = false;
						execMatch.result[matchCasePromiseResultSymbol] = pResult;
						this._runIfExpressions(plugInfo,attrib,state,exp,false);
					});
				}
			}
			// Check Match Case
			if(result!==false){
				let obsRecording = signalObs && signalObs.startRecording();
				result = this._matchCase(matchResult,result,signalObs);
				if(obsRecording) signalObs.stopRecording();
			}
		}
		// Continue with result
		if(isTemplate) this._handleTemplateIfResult(plugInfo,attrib,state,exp,updateIndex,result);
		else this._handleRegularIfResult(plugInfo,attrib,state,exp,updateIndex,result);
		// if updateOthers, update remaining if elements
		if(updateOthers && !(ifElseValue===null || ifCaseValue===null)){
			let anyShowing = !!state.showing;
			for(let e=state.element.nextSibling; e; e=e.nextSibling){
				let isEl=e instanceof Element, eState=this.stateMap.get(e);
				if(!eState && !isEl) continue;
				if(!eState && isEl) break;
				if(eState){
					if(e===eState.tplAnchorStart && eState.tplAnchorEnd){ e = eState.tplAnchorEnd; continue; }
					if(!eState.depList?.has(state)) break;
					eState.element?.$if?.(false);
				}
			}
		}
	}
	
	_matchCase(matchObj,caseObj){
		try{
			// Resolve Signals
			matchObj = this.ScopeDom.resolveSignal(matchObj);
			caseObj = this.ScopeDom.resolveSignal(caseObj);
			// Equals
			if(matchObj===caseObj) return true;
			if(typeof caseObj==='string' || typeof caseObj==='number' || typeof caseObj==='boolean') return false;
			if(caseObj===void 0 || caseObj===null || caseObj instanceof Error) return false;
			if(matchObj instanceof Promise || caseObj instanceof Promise) return false;
			// Regex
			if(caseObj instanceof RegExp && typeof matchObj==='string') return caseObj.test(matchObj);
			// Special Function
			if(caseObj instanceof Function && Object.hasOwn(caseObj,matchCaseOperatorSymbol)){
				let operator = caseObj[matchCaseOperatorSymbol];
				let arr = caseObj(matchObj), result = false;
				if(operator==='or'){ result=false; for(let v of arr) if(this._matchCase(matchObj,v)) return true; }
				else if(operator==='and'){ result=true; for(let v of arr) if(!this._matchCase(matchObj,v)) return false; }
				else if(operator==='not'){ result=true; for(let v of arr) if(this._matchCase(matchObj,v)) return false; }
				return result;
			}
			// Function
			if(caseObj instanceof Function) return !!caseObj(matchObj);
			// Map
			if(matchObj instanceof Map || matchObj instanceof WeakMap){
				if(!(caseObj instanceof Map) && typeof caseObj==='object' && caseObj!==null){
					if(Symbol.iterator in caseObj) return false;
					caseObj = new Map(Object.entries(Object(caseObj)));
				}
				if(caseObj instanceof Map){
					for(let [key,value] of caseObj) if(!matchObj.has(key) || !this._matchCase(matchObj.get(key),value)) return false;
					return true;
				}
			}
			// Array / Iterable
			let isMatchArray = matchObj instanceof Array, isMatchIterable = !isMatchArray && (typeof matchObj==='object' && matchObj!==null && Symbol.iterator in matchObj);
			let isCaseArray = caseObj instanceof Array, isCaseIterable = !isCaseArray && (typeof caseObj==='object' && caseObj!==null && Symbol.iterator in caseObj);
			if((isMatchArray || isMatchIterable) && (isCaseArray || isCaseIterable)){
				if(!isMatchArray && isMatchIterable) matchObj = Array.from(matchObj);
				if(!isCaseArray && isCaseIterable) caseObj = Array.from(caseObj);
				for(let i=0, cl=caseObj.length, ml=matchObj.length; i<cl; i++){
					if(i>=ml) return false;
					if(!this._matchCase(matchObj[i],caseObj[i])) return false;
				}
				return true;
			}
			// Object
			if(typeof matchObj==='object' && typeof caseObj==='object' && matchObj!==null && caseObj!==null){
				matchObj = Object(matchObj); caseObj = Object(caseObj);
				for(let key of Object.keys(caseObj)) if(!Object.hasOwn(matchObj,key) || !this._matchCase(matchObj[key],caseObj[key])) return false;
				return true;
			}
		}catch(err){ console.warn('pluginIf: matchCase error:',caseObj,`\n`,err); }
		return false;
	}
	
	_handleRegularIfResult(plugInfo,attrib,state,exp,callUpdateIndex,nowShowing){
		let { instance, isElementLoaded } = this;
		let { element } = plugInfo;
		let { attribute } = attrib;
		let { showing:wasShowing, options, anchor, defaultDisplay, onShowExec, onHideExec, updateIndex } = state;
		let { domRemove } = options;
		// Ignore old calls
		if(updateIndex>callUpdateIndex) return;
		state.updateIndex++;
		// Update state
		state.showing = nowShowing = !!nowShowing;
		element.$ifResult = nowShowing;
		// Has result changed
		let differentResult = (wasShowing===null || wasShowing!==nowShowing);
		// While element isn't loaded, fallback to style.display
		if(domRemove && !nowShowing && !isElementLoaded(element)){
			instance.onElementLoaded(element,this._runIfExpressions.bind(this,plugInfo,attrib,state,exp));
			domRemove = false;
		}
		// Remove/Restore DOM
		if(domRemove){
			if(defaultDisplay!==null){ element.style.display=defaultDisplay; defaultDisplay=null; }
			// Check Anchor
			if(!anchor){
				state.anchor = anchor = document.createComment(' If-Anchor: '+element.cloneNode(false).outerHTML+' ');
			}
			if(anchor && !nowShowing){
				this.stateMap.set(anchor,state);
				this.instance.cacheConnectedNodes.add(anchor);
			}
			// Show
			if(differentResult && nowShowing){
				if(anchor.isConnected){
					instance.elementScopeSetAlias(element,anchor);
					anchor.replaceWith(element);
				}
				if(onShowExec) onShowExec.runFn();
			}
			// Hide
			if(differentResult && !nowShowing){
				if(!anchor.$pluginIfElement) anchor.$pluginIfElement = element;
				if(element.isConnected){
					instance.elementScopeSetAlias(anchor,element);
					element.replaceWith(anchor);
				}
				if(onHideExec) onHideExec.runFn();
			}
		}
		// Change style.display
		else {
			if(defaultDisplay===null) state.defaultDisplay = defaultDisplay = element.style.display||'';
			if(differentResult && nowShowing){
				element.style.display = defaultDisplay;
				if(onShowExec) onShowExec.runFn();
			}
			if(differentResult && !nowShowing){
				element.style.setProperty('display','none','important');
				if(onHideExec) onHideExec.runFn();
			}
		}
	}
	
	_handleTemplateIfResult(plugInfo,attrib,state,exp,callUpdateIndex,nowShowing){
		let { instance, isElementLoaded } = this;
		let { element } = plugInfo;
		let { attribute } = attrib;
		let { showing:wasShowing, options, onShowExec, onHideExec } = state;
		let { tplNodes, tplAnchorStart, tplAnchorEnd, tplDefaultDisplay, updateIndex } = state;
		let { domRemove } = options;
		// Ignore old calls
		if(updateIndex>callUpdateIndex) return;
		state.updateIndex++;
		// Update state
		state.showing = nowShowing = !!nowShowing;
		element.$ifResult = nowShowing;
		// Has result changed
		let actionResult = (wasShowing===null || wasShowing!==nowShowing);
		// Don't run while element isn't loaded
		if(!isElementLoaded(element)){ instance.onElementLoaded(element,this._runIfExpressions.bind(this,plugInfo,attrib,state,exp)); return; }
		// Create Anchors
		if(!tplAnchorStart || !tplAnchorEnd){
			tplAnchorStart = state.tplAnchorStart = state.tplAnchorStart||document.createComment(' If-Start-Anchor: '+element.nodeName+' '+attribute+' '+(exp?.length>0?exp+' ':''));
			tplAnchorEnd = state.tplAnchorEnd = state.tplAnchorEnd||document.createComment(' If-End-Anchor ');
			state.anchor = tplAnchorEnd; // alias, but dont add to stateMap
			this.stateMap.set(tplAnchorStart,state);
			this.stateMap.set(tplAnchorEnd,state);
			actionResult = true;
		}
		// Check DOM structure
		if(tplAnchorStart.parentNode || tplAnchorEnd.parentNode){
			let correctDOM = false;
			if(tplAnchorStart.parentNode===element.parentNode && tplAnchorStart.parentNode===tplAnchorEnd.parentNode){
				for(let e=tplAnchorStart.nextSibling; e; e=e.nextSibling) if(e===tplAnchorEnd){ correctDOM=true; break; }
			}
			if(!correctDOM){
				console.warn("pluginIf: DOM has been externally modified, correcting DOM structure",element);
				actionResult = true;
				// Re-Insert Anchors
				element.parentNode.insertBefore(tplAnchorEnd,element.nextSibling);
				tplAnchorEnd.parentNode.insertBefore(tplAnchorStart,tplAnchorEnd);
				// Re-Insert Nodes
				if(tplNodes?.size>0){
					let docFragment = document.createDocumentFragment();
					for(let n of tplNodes) docFragment.appendChild(n);
					tplAnchorEnd.parentNode.insertBefore(docFragment,tplAnchorEnd);
				}
			}
		}
		// On Hide, Save existing DOM nodes
		let hasDirectTextNodes = false;
		if((actionResult && !nowShowing) && tplAnchorStart.parentNode && tplAnchorEnd.parentNode){
			let nodes = new Set();
			for(let e=tplAnchorStart.nextSibling; e && e!==tplAnchorEnd; e=e.nextSibling){
				if(!domRemove && e.nodeType===textNodeType) hasDirectTextNodes = true;
				nodes.add(e);
			}
			tplNodes = state.tplNodes = nodes;
		}
		// On Show, Create nodes from template
		if((actionResult && nowShowing) && (!tplNodes || tplNodes.size===0)){
			if(!tplNodes) tplNodes = state.tplNodes = new Set();
			for(let n of [...element.content.cloneNode(true).childNodes]){
				tplNodes.add(n);
				instance.elementScopeSetAlias(n,element);
			}
		}
		// Setup tplDefaultDisplay
		if(!tplDefaultDisplay) tplDefaultDisplay = state.tplDefaultDisplay = new WeakMap(); // node -> defaultDisplay
		// Prevent direct textNodes on style display mode
		if(!domRemove && hasDirectTextNodes){
			console.warn("pluginIf: Converting to if:dom to hide textNodes",element);
			for(let n of tplNodes) if(n.style) n.style.display = tplDefaultDisplay.get(n) || '';
			domRemove = options.domRemove = true;
		}
		// Remove/Insert DOM
		if(domRemove){
			// Hide
			if(actionResult && !nowShowing){
				// Remove Nodes
				if(tplNodes?.size>0) for(let n of tplNodes) n.remove();
				// Remove Anchors
				tplAnchorStart.parentNode?.removeChild(tplAnchorStart);
				tplAnchorEnd.parentNode?.removeChild(tplAnchorEnd);
				// Callback on-hide
				if(onHideExec) onHideExec.runFn();
			}
			// Show
			if(actionResult && nowShowing){
				// Insert Anchors
				element.parentNode.insertBefore(tplAnchorEnd,element.nextSibling);
				tplAnchorEnd.parentNode.insertBefore(tplAnchorStart,tplAnchorEnd);
				// Insert Nodes
				let docFragment = document.createDocumentFragment();
				for(let n of tplNodes){
					instance.elementScopeSetAlias(n,element);
					docFragment.appendChild(n);
				}
				tplAnchorEnd.parentNode.insertBefore(docFragment,tplAnchorEnd);
				// Callback on-show
				if(onShowExec) onShowExec.runFn();
			}
		}
		// Hide/Show style display
		if(!domRemove){
			// Hide
			if(actionResult && !nowShowing){
				if(tplNodes?.size>0) for(let n of tplNodes){
					if(!n.style) continue;
					if(!tplDefaultDisplay.has(n)) tplDefaultDisplay.set(n,n.style.display||'');
					n.style.setProperty('display','none','important');
				}
				if(onHideExec) onHideExec.runFn();
			}
			// Show
			if(actionResult && nowShowing){
				// If anchor isn't connected, insert anchors & nodes
				if(!tplAnchorStart.parentNode){
					// Insert Anchors
					element.parentNode.insertBefore(tplAnchorEnd,element.nextSibling);
					tplAnchorEnd.parentNode.insertBefore(tplAnchorStart,tplAnchorEnd);
					// Insert Nodes
					let docFragment = document.createDocumentFragment();
					for(let n of tplNodes){
						instance.elementScopeSetAlias(n,element);
						docFragment.appendChild(n);
					}
					tplAnchorEnd.parentNode.insertBefore(docFragment,tplAnchorEnd);
				}
				// Set Style Display
				for(let n of tplNodes){
					if(!n.style) continue;
					n.style.display = tplDefaultDisplay.get(n) || '';
				}
				if(onShowExec) onShowExec.runFn();
			}
		}
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginIf) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginIf=pluginIf);
