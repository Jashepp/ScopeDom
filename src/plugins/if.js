"use strict";

/** @type {number} Text node type constant from `document.TEXT_NODE`. */
const textNodeType = document.TEXT_NODE;

/** Symbol key used to signal that a Promise result is waiting for case-match evaluation. */
const matchCasePromiseWaitSymbol = Symbol('pluginIf-matchCase-promise-wait');

/** Symbol key used to store the resolved promise value in case-match results. */
const matchCasePromiseResultSymbol = Symbol('pluginIf-matchCase-promise-result');

/** Symbol key identifying special operator functions (OR/AND/NOT) within `matchCaseScope`. */
const matchCaseOperatorSymbol = Symbol('pluginIf-matchCaseScope-operator');

/**
 * Factory function that creates a callable function with an attached operator symbol.
 * Used by {@link matchCaseScope} to produce OR/AND/NOT operators for case matching.
 * @param {string} op - The operator name ('or', 'and', or 'not').
 * @param {Array} arr - The array of values to operate on.
 */
const matchCaseOperatorFn = (op,arr)=>{
	let fn=_=>arr; fn[matchCaseOperatorSymbol]=op; return fn;
};

/**
 * Pre-frozen object providing special operator functions for case matching:
 * - `_()` — always returns true.
 * - `_or(...values)` — returns true if any value matches.
 * - `_and(...values)` — returns true only if all values match.
 * - `_not(...values)` — returns true if no values match.
 */
const matchCaseScope = Object.freeze({
	_(v){ return true; },
	_or(...arr){ return matchCaseOperatorFn('or',arr); },
	_and(...arr){ return matchCaseOperatorFn('and',arr); },
	_not(...arr){ return matchCaseOperatorFn('not',arr); },
});

/**
 * Plugin for conditional rendering based on expression evaluation.
 * 
 * Key features:
 * - if/else matching with conditional branches
 * - if-match/if-case matching for pattern-based conditionals
 * - DOM swapping (replacing elements with anchor comments)
 * - CSS style-based hiding (using `display: none !important`)
 * - Template parsing with start/end anchor nodes
 * 
 * @class pluginIf
 */
export class pluginIf {
	
	/**
	 * @returns {string} The name of the plugin
	*/
	get name(){ return 'if'; }
	
	/**
	 * @param {Object} ScopeDom - The ScopeDom class
	 * @param {Object} instance - The ScopeDom instance
	 */
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.isElementLoaded = ScopeDom.isElementLoaded;
		this.eventMap = new WeakMap(); // element, set (removeEvent cb)
		this.stateMap = new WeakMap(); // element, state
	}
	
	/**
	 * Called when the plugin connects to an element.
	 * 
	 * Sets up conditional rendering logic based on if/if-else/if-match/if-case attributes.
	 * For template elements that are not yet loaded, defers connection until they become available.
	 * Also handles moving `repeat` attributes from templates to their inner content.
	 * 
	 * @param {Object} plugInfo - Information about the plugin connection
	 * @param {HTMLElement} plugInfo.element - The element being connected (may be a template)
	 * @param {Map<string, Object>} plugInfo.attribs - Parsed ScopeDom attributes of the element
	 */
	onConnect(plugInfo){
		let { instance, isElementLoaded } = this;
		let { element, attribs } = plugInfo;
		if(!element.isConnected) return;
		// If it's a template and not loaded yet, defer connection until it is loaded.
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
	
	/**
	 * Moves repeat attributes from a template element to its inner content.
	 * 
	 * This creates an intermediate comment node and restructures the template's
	 * internal structure so that repeat logic applies to nested templates rather
	 * than the outer template itself.
	 * 
	 * @param {Object} plugInfo - Contains `element` (template) and `attribs`
	 * @param {Object} targetAttrib - Parsed ScopeDom repeat attribute of the element
	 * @param {string} defaultAttribName - Fallback attrib name key, e.g. `'default repeat'`
	 * @private
	 */
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
			// Apply options to the new template element
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
	
	/**
	 * Called when the plugin disconnects from an element.
	 * Cleans up state, event listeners, and restores original style.display.
	 * 
	 * Handles different scenarios for regular elements vs template anchors, including
	 * partial cleanup (fake disconnect) where some restoration is skipped.
	 * 
	 * @param {Object} plugInfo - Contains `element`, `elementScopeCtrl` and `attribs`
	 * @param {HTMLElement} plugInfo.element - The element being disconnected
	 * @param {Map<string, Object>} plugInfo.attribs - Parsed ScopeDom attributes of the element
	 * @param {boolean} [fakeDC=false] - If true, indicates a "fake" disconnect where some restoration (e.g., style.display) is skipped
	 */
	onDisconnect(plugInfo,fakeDC=false){
		let { element, elementScopeCtrl, attribs } = plugInfo;
		// Get State
		let state = this.stateMap.get(element);
		if(!state) return;
		let removeState=true, removeEvents=true;
		let { signalObs, isOnlyMatch, anchor, defaultDisplay, isTemplate, tplAnchorStart, tplAnchorEnd } = state;
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
		// Cleanup signalObserver
		if(removeEvents && signalObs){ signalObs.clear(); state.signalObs=null; }
	}
	
	/**
	 * Configures the if configuration for an element based on its attributes.
	 *
	 * This method:
	 * 1. Extracts expression values from `if`, `if else`, `if match`, and `if case` attributes.
	 * 2. Parses options like `onlyOnce`, `dom`, `update scope`, `update dom`, `on show`, `on hide`, and `default`.
	 * 3. Creates a state object containing signal controllers, anchor references, and execution functions.
	 *
	 * @param {Object} plugInfo - Contains `element` and `elementScopeCtrl`
	 * @param {Map<string, Object>} ifAttribs - Parsed ScopeDom if attributes of the element
	 * @private
	 */
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
		// Register Events that trigger if-expression when they occur
		if(updateEvent?.length>0) this._registerEvent(element,elementScopeCtrl.ctrl.$on(updateEvent,triggerExec,{ __proto__:null, capture:false, passive:true },true));
		if(updateDomEvent?.length>0) this._registerEvent(element,elementScopeCtrl.$onDom(updateDomEvent,triggerExec,{ __proto__:null, capture:true, passive:true },true));
		// Continue when ready
		instance.onReady(function onReadyPluginIf(){
			this._runIfExpressions(plugInfo,expAttrib,state,exp);
		}.bind(this),false);
	}
	
	/**
	 * Registers an event removal function for an element.
	 *
	 * @param {HTMLElement} element - The element to track
	 * @param {Function} removeEvent - The function to remove the event listener
	 * @private
	 */
	_registerEvent(element,removeEvent){
		if(!this.eventMap.has(element)) this.eventMap.set(element,new Set());
		this.eventMap.get(element).add(removeEvent);
	}
	
	/**
	 * Checks if the expression has already executed at least once for this state,
	 * which is used by the `onlyOnce` option to prevent re-execution.
	 *
	 * @param {Object} state - The current if state object.
	 * @returns {boolean} True if the expression has been executed at least once; false otherwise.
	 * @private
	 */
	_hasRanOnce(state){
		let { exec, anchor, defaultDisplay, options:{ onlyOnce, domRemove } } = state;
		return (onlyOnce && exec);
	}
	
	/**
	 * Executes an expression in the context of a node.
	 * Creates a signal observer and wraps the run function for signal tracking.
	 *
	 * @param {HTMLElement} element - The root element for the expression context
	 * @param {string} exp - The expression to execute
	 * @param {boolean} useReturn - Return a value from `runFn()`
	 * @param {Object|null} extra - Extra properties spread into the exec object
	 * @param {Object} signalObs - The signal observer to wrap the run function
	 * @returns {Object} The execution result
	 * @private
	 */
	_execExpression(plugInfo,exp,useReturn=true,extra=null,signalObs=null){
		if(!(exp?.length>0)) return null;
		let exec = this.instance.elementExecExp(plugInfo.elementScopeCtrl,exp,{ __proto__:null, $expression:exp, ...extra },{ silentHas:true, useReturn, run:false });
		if(signalObs) exec.runFn = signalObs.wrapRecorder(exec.runFn);
		return exec;
	}
	
	/**
	 * Evaluates `if`/`if-else`/`if-match`/`if-case` expressions and updates conditional rendering state.
	 * 
	 * This method:
	 * 1. Builds a dependency list (`depList`) of sibling elements with related if-state when handling empty `if-else` or `if-case`.
	 * 2. Sets up signal observers for re-evaluation on change (via RAF scheduling).
	 * 3. Prepares "on show" / "on hide" callback executors.
	 * 4. Executes the main expression and delegates to `_handleResult()`.
	 * 
	 * @param {Object} plugInfo - Contains `element`, `elementScopeCtrl`, and `attribs`
	 * @param {Object} attrib - The attribute descriptor for this element (used in result handling)
	 * @param {Object} state - Current conditional rendering state
	 * @param {string|null} exp - Expression string to evaluate, or null if none was provided
	 * @param {boolean} runMatch - Perform match-case evaluation logic (default: true)
	 * @param {boolean} updateOthers - Propagate updates to dependent sibling elements (default: false)
	 * @private
	 */
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
		// Setup signalObserver
		if(!signalObs){
			let self=this; signalObs = state.signalObs = (signalObs || state.signalCtrl.createObserver());
			signalObs.addListener(function pluginIf_signalObserver(){
				let updateIndex = state.updateIndex;
				self.ScopeDom.animFrameHelper.onceRAF(state,signalObs,function pluginIf_signalObserver_RAF(){
					if(state.updateIndex!==updateIndex) return;
					signalObs.clearSignals();
					self._runIfExpressions(plugInfo,attrib,state,exp,runMatch,true);
				});
			});
		}
		// Build Exec for On Show / On Hide - no signalObserver for these
		if(onShowEvent?.length>0 && !state.onShowExec) state.onShowExec = this._execExpression(plugInfo,onShowEvent,false);
		if(onHideEvent?.length>0 && !state.onHideExec) state.onHideExec = this._execExpression(plugInfo,onHideEvent,false);
		// Build / Run Expression
		if(result===null){
			let execExtra = null;
			if(exp?.length>0 && ifCaseValue?.length>0 && ifCaseValue===exp) execExtra = matchCaseScope;
			if(!exec) exec = state.exec = this._execExpression(plugInfo,exp,true,execExtra,signalObs);
			result = element.$ifResult = exec.runFn();
		}
		this._handleResult(plugInfo,attrib,state,exp,updateIndex,runMatch,updateOthers,result);
	}
	
	/**
	 * Processes conditional rendering results after an expression has been evaluated.
	 * 
	 * This method handles:
	 * 1. Signal resolution and promise handling (deferred processing via RAF).
	 * 2. `if-match` / `if-case` match evaluation logic with recursive matching support.
	 * 3. Promise-based expressions use a default value until resolved, then re-triggers `_handleResult`.
	 * 4. Delegation to `_handleTemplateIfResult()` or `_handleRegularIfResult()` based on template mode.
	 * 
	 * @param {Object} plugInfo - Contains element and scope control info
	 * @param {Object} attrib - Attribute descriptor for this element (used in result handling)
	 * @param {Object} state - Current conditional rendering state
	 * @param {string|null} exp - Expression string to evaluate, or null if none was provided
	 * @param {number} updateIndex - The current update index; older results are ignored if a newer one exists
	 * @param {boolean} runMatch - Match-case evaluation logic should be performed (default: true)
	 * @param {boolean} updateOthers - Dependent sibling elements should also receive updates (default: false)
	 * @param {*} result - The evaluated expression result to process
	 * @private
	 */
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
		// If the match result is a promise that contains a resolved value, ensure updates are propagated to other dependent elements
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
				// Execute the match expression
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
	
	/**
	 * Implements the "match case" comparison logic used by `if-match` / `if-case` conditional rendering.
	 * 
	 * This method supports multiple matching modes:
	 * - Strict equality (`===`) for primitive values and objects.
	 * - RegExp testing when the case object is a regex pattern and match value is a string.
	 * - Special operator functions (OR/AND/NOT) defined via `matchCaseOperatorSymbol`.
	 * - Custom function callbacks where the caseObj is invoked with matchObj as argument.
	 * - Map subset matching for WeakMap/Map objects.
	 * - Array/Iterable item comparison by index position.
	 * - Object property-level recursive matching (checks if all case properties exist in match).
	 * 
	 * On error, a warning is logged and `false` is returned.
	 * 
	 * @param {*} matchObj - The value to be matched (usually the evaluated expression result)
	 * @param {*} caseObj - The pattern/object against which `matchObj` is compared
	 * @returns {boolean} True if successful match occurred; otherwise, returns false
	 * @private
	 */
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
	
	/**
	 * Processes evaluated expression results for non-template elements.
	 * 
	 * This method handles:
	 * - DOM removal/restoration mode (`domRemove`): Replaces the element with an anchor comment and vice versa.
	 *   When showing, replaces anchor with actual element; when hiding, replaces element with anchor.
	 * - CSS display style mode: Sets `display: none !important` to hide, or restores original display style to show.
	 * 
	 * @param {Object} plugInfo - Contains `element`
	 * @param {Object} attrib - Attribute descriptor for this element (used in result handling)
	 * @param {Object} state - Current conditional rendering state
	 * @param {string|null} exp - Expression string to evaluate, or null if none was provided
	 * @param {number} callUpdateIndex - The update index at which this handler was called (older calls are ignored)
	 * @param {boolean} nowShowing - Element should currently be shown (`true`) or hidden (`false`)
	 * @private
	 */
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
	
	/**
	 * Processes evaluated expression results specifically for `<template>` elements using 
	 * start/end anchor comment nodes and template content node management.
	 * 
	 * This method:
	 * 1. Creates start/end anchor comment nodes if they don't exist yet (first run).
	 * 2. Validates the current DOM structure and corrects it if externally modified.
	 * 3. Show/Hide
	 *    - On hide: saves existing child nodes into `tplNodes` Set, and removes anchors from view.
	 *    - On show: re-inserts anchors and previously saved/created template content nodes.
	 *
	 * @param {Object} plugInfo - The plugInfo object containing `element`
	 * @param {Object} attrib - Attribute descriptor for this element (used in result handling)
	 * @param {Object} state - Current conditional rendering state
	 * @param {string|null} exp - Expression string to evaluate, or null if none was provided
	 * @param {number} callUpdateIndex - The update index at which this handler was called (older calls are ignored)
	 * @param {boolean} nowShowing - Template content should currently be shown (`true`) or hidden (`false`)
	 * @private
	 */
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
		// Check if the anchors are still in the DOM; if not, they might have been moved or removed externally
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
		// When hiding, if there are direct text nodes, we must switch to 'dom' mode to ensure they are also hidden
		let hasDirectTextNodes = false;
		if((actionResult && !nowShowing) && tplAnchorStart.parentNode && tplAnchorEnd.parentNode){
			let nodes = new Set();
			for(let e=tplAnchorStart.nextSibling; e && e!==tplAnchorEnd; e=e.nextSibling){
				if(!domRemove && e.nodeType===textNodeType) hasDirectTextNodes = true;
				nodes.add(e);
			}
			tplNodes = state.tplNodes = nodes;
		}
		// When showing, if no nodes are saved, clone them from the template element
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
