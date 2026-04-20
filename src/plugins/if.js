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
	static get name(){ return 'if'; }
	
	#eventMap; #stateMap;
	
	/**
	 * @param {Object} ScopeDom - The ScopeDom class
	 * @param {Object} instance - The ScopeDom instance
	 */
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.isElementLoaded = ScopeDom.isElementLoaded;
		this.#eventMap = new WeakMap(); // element, set (removeEvent cb)
		this.#stateMap = new WeakMap(); // element, state
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
		let ifAttributeNames = ['if','if else','if match','if case'];
		let ifAttributes=new Map(), repeatAttribute;
		if(attribs?.size>0) for(let [attribName,attrib] of attribs){
			let { nameKey } = attrib;
			if(ifAttributeNames.indexOf(nameKey)!==-1) ifAttributes.set(nameKey,attrib);
			else if(nameKey==='repeat') repeatAttribute = attrib;
		}
		if(ifAttributes.size===0) return;
		if(repeatAttribute && element.nodeName==='TEMPLATE') this.#moveAttrib(plugInfo,repeatAttribute,'default repeat');
		this.#configureIf(plugInfo,ifAttributes);
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
	 * @param {string} fallbackAttribName - Fallback attrib name key, e.g. `'default repeat'`
	 * @private
	 */
	#moveAttrib(plugInfo,targetAttrib,fallbackAttribName){
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
		if(attribs.has(fallbackAttribName)){
			let defaultRepeat = attribs.get(fallbackAttribName);
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
		let state = this.#stateMap.get(element);
		if(!state) return;
		let shouldRemoveState=true, shouldRemoveEvents=true;
		let { signalObs, isOnlyMatch, anchor, defaultDisplay, isTemplate, tplAnchorStart, tplAnchorEnd } = state;
		let anchorDC = (element===anchor || element===tplAnchorStart || element===tplAnchorEnd);
		if(anchorDC) element = state.element;
		let hasExecuted = this.#hasExecutedOnce(state);
		if(!isOnlyMatch && !isTemplate){
			// Anchor disconnect
			if(!hasExecuted && anchorDC && element.isConnected) return;
			// DOM mode: only anchor is connected, keep state & events
			if(!hasExecuted && !element.isConnected && anchor && anchor.isConnected) return;
			// DOM & Style mode: ran only once
			if(hasExecuted){
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
		if(element.isConnected) shouldRemoveState = shouldRemoveEvents = false;
		// Remove State
		if(shouldRemoveState){
			if(this.#stateMap.has(element)) this.#stateMap.delete(element);
			if(anchor && this.#stateMap.has(anchor)) this.#stateMap.delete(anchor);
			if(tplAnchorStart && this.#stateMap.has(tplAnchorStart)) this.#stateMap.delete(tplAnchorStart);
			if(tplAnchorEnd && this.#stateMap.has(tplAnchorEnd)) this.#stateMap.delete(tplAnchorEnd);
		}
		// Remove event listeners - for element
		if(shouldRemoveEvents && this.#eventMap.has(element)){
			let set = this.#eventMap.get(element);
			for(let removeEvent of set) removeEvent();
			this.#eventMap.delete(element);
		}
		// Cleanup signalObserver
		if(shouldRemoveEvents && signalObs){ signalObs.clear(); state.signalObs=null; }
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
	 * @param {Map<string, Object>} ifAttributes - Parsed ScopeDom if attributes of the element
	 * @private
	 */
	#configureIf(plugInfo,ifAttributes){
		let { instance } = this;
		let { element, elementScopeCtrl } = plugInfo;
		let isTemplate = (element.nodeName==='TEMPLATE');
		// Skip when existing state
		if(this.#stateMap.has(element)) return;
		// Skip empty template
		if(isTemplate && !(element.content?.childNodes?.length>0)) return console.warn("pluginIf: template has no content");
		// Value / Expression
		let expression = null, expressionAttrib = null;
		for(let [nameKey,attrib] of ifAttributes){
			if(nameKey==='if' || nameKey==='if else' || nameKey==='if case'){
				if(attrib.value?.length>0){ expression = attrib.value; expressionAttrib = attrib; }
				if(expressionAttrib===null) expressionAttrib = attrib;
			}
		}
		for(let [nameKey,attrib] of ifAttributes){
			if(nameKey==='if' || nameKey==='if else' || nameKey==='if case'){
				if(expression===null && !(attrib.value?.length>0)){
					let value = attrib.value = instance.elementAttribFallbackOptionValue(attrib,['once','dom']);
					if(value?.length>0){ expression = value; expressionAttrib = attrib; }
				}
			}
			if(nameKey==='if match'){
				attrib.value = instance.elementAttribFallbackOptionValue(attrib,['once']);
			}
		}
		// Options
		let attribOpts = new Map(), matchOpts = new Map();
		for(let [nameKey,attrib] of ifAttributes){
			if(nameKey==='if' || nameKey==='if else' || nameKey==='if case'){
				let options = instance.elementAttribOptionsWithDefaults(element,attrib);
				if(options.size>0) attribOpts = new Map([...attribOpts,...options]);
			}
			if(nameKey==='if match'){
				matchOpts = instance.elementAttribOptionsWithDefaults(element,attrib);
			}
		}
		// Attrib Values
		let ifAttributeValue = ifAttributes.has('if') ? ifAttributes.get('if').value : false,
		ifElseAttributeValue = ifAttributes.has('if else') ? ifAttributes.get('if else').value : false,
		ifMatchAttributeValue = ifAttributes.has('if match') ? ifAttributes.get('if match').value : false,
		ifCaseAttributeValue = ifAttributes.has('if case') ? ifAttributes.get('if case').value : false;
		let isOnlyMatchMode = ((ifMatchAttributeValue?.length>0 || ifMatchAttributeValue===null) && !expressionAttrib);
		// Options
		let onlyOnceOption = instance.elementAttribParseOption(element,attribOpts,'once',{ default:false, emptyTrue:true, runExp:true }); // $if:once
		let domRemoveOption = instance.elementAttribParseOption(element,attribOpts,'dom',{ default:false, emptyTrue:true, runExp:true }); // $if:dom or  $if:dom='exp' - same as $if='exp' $if:dom
		let updateEvent = instance.elementAttribParseOption(element,attribOpts,'update scope',{ default:'$update', emptyTrue:false, runExp:true }).value; // $if:update-scope='event', $emit('event')
		let updateDomEvent = instance.elementAttribParseOption(element,attribOpts,'update dom',{ default:'$update', emptyTrue:false, runExp:true }).value; // $if:update-dom='event', $emitDom('event')
		let onShowEvent = instance.elementAttribParseOption(element,attribOpts,'on show',{ default:null, emptyTrue:false, runExp:false }).value; // $if:on-show='exp'
		let onHideEvent = instance.elementAttribParseOption(element,attribOpts,'on hide',{ default:null, emptyTrue:false, runExp:false }).value; // $if:on-hide='exp'
		let defaultValue = instance.elementAttribParseOption(element,attribOpts,'default',{ default:false, emptyTrue:false, runExp:true }).value; // $if:default='true' (eg, promise)
		// State
		onlyOnceOption=(onlyOnceOption.value===true); domRemoveOption=(domRemoveOption.value===true);
		let state = { __proto__:null,
			signalCtrl: elementScopeCtrl.ctrl.signalCtrl, signalObs:null,
			element, isOnlyMatchMode, ifAttributeValue, ifElseAttributeValue, ifMatchAttributeValue, ifCaseAttributeValue, matchOpts, depList:null,
			options:{ __proto__:null, onlyOnceOption, domRemoveOption, onShowEvent, onHideEvent, defaultValue },
			showing:null, exec:null, execMatch:null, anchor:null, defaultDisplay:null, onShowExec:null, onHideExec:null, updateIndex:0,
			isTemplate, tplNodes:null, tplAnchorStart:null, tplAnchorEnd:null, tplDefaultDisplay:null,
		};
		if(!this.#stateMap.has(element)) this.#stateMap.set(element,state);
		// Skip if only if-match (after state is set)
		if(isOnlyMatchMode) return;
		// Trigger Exec
		let triggerExec = this.#runIfExpressions.bind(this,plugInfo,expressionAttrib,state,expression);
		// Add $if() to element & element context
		elementScopeCtrl.execContext.$if = element.$if = triggerExec;
		// Register Events that trigger if-expression when they occur
		if(updateEvent?.length>0) this.#registerEventRemoval(element,elementScopeCtrl.ctrl.$on(updateEvent,triggerExec,{ __proto__:null, capture:false, passive:true },true));
		if(updateDomEvent?.length>0) this.#registerEventRemoval(element,elementScopeCtrl.$onDom(updateDomEvent,triggerExec,{ __proto__:null, capture:true, passive:true },true));
		// Continue when ready
		instance.onReady(function onReadyPluginIf(){
			this.#runIfExpressions(plugInfo,expressionAttrib,state,expression);
		}.bind(this),false);
	}
	
	/**
	 * Registers an event removal function for an element.
	 *
	 * @param {HTMLElement} element - The element to track
	 * @param {Function} removeEvent - The function to remove the event listener
	 * @private
	 */
	#registerEventRemoval(element,removeEvent){
		if(!this.#eventMap.has(element)) this.#eventMap.set(element,new Set());
		this.#eventMap.get(element).add(removeEvent);
	}
	
	/**
	 * Checks if the expression has already executed at least once for this state,
	 * which is used by the `onlyOnce` option to prevent re-execution.
	 *
	 * @param {Object} state - The current if state object.
	 * @returns {boolean} True if the expression has been executed at least once; false otherwise.
	 * @private
	 */
	#hasExecutedOnce(state){
		let { exec, anchor, defaultDisplay, options:{ onlyOnce, domRemove } } = state;
		return (onlyOnce && exec);
	}
	
	/**
	 * Executes an expression in the context of a node.
	 * Creates a signal observer and wraps the run function for signal tracking.
	 *
	 * @param {HTMLElement} element - The root element for the expression context
	 * @param {string} expression - The expression to execute
	 * @param {boolean} useReturn - Return a value from `runFn()`
	 * @param {Object|null} extraProps - Extra properties spread into the exec object
	 * @param {Object} signalObs - The signal observer to wrap the run function
	 * @returns {Object} The execution result
	 * @private
	 */
	#executeExpression(element,expression,useReturn=true,extraProps=null,signalObs){
		let eCtrl = this.instance.elementScopeCtrl(element);
		let exec = this.instance.elementExecExp(eCtrl,expression,{ __proto__:null, $expression:expression, ...extraProps },{ silentHas:true, useReturn, run:false });
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
	 * 4. Executes the main expression and delegates to `#handleResult()`.
	 * 
	 * @param {Object} plugInfo - Contains `element`, `elementScopeCtrl`, and `attribs`
	 * @param {Object} attrib - The attribute descriptor for this element (used in result handling)
	 * @param {Object} state - Current conditional rendering state
	 * @param {string|null} expression - Expression string to evaluate, or null if none was provided
	 * @param {boolean} performMatch - Perform match-case evaluation logic (default: true)
	 * @param {boolean} updateDependents - Propagate updates to dependent sibling elements (default: false)
	 * @private
	 */
	#runIfExpressions(plugInfo,attrib,state,expression,performMatch=true,updateDependents=false){
		let { instance, isElementLoaded } = this;
		let { element, elementScopeCtrl, attribs } = plugInfo;
		let { signalObs, ifAttributeValue, ifElseAttributeValue, ifMatchAttributeValue, ifCaseAttributeValue, options, depList, showing:wasShowing, exec, anchor, updateIndex, isTemplate } = state;
		let { onShowEvent, onHideEvent } = options;
		if(!this.#stateMap.has(element)) return;
		if(this.#hasExecutedOnce(state)) return;
		performMatch = performMatch!==false;
		let result = null;
		// Specified or Empty if-else or if-case
		if(ifElseAttributeValue?.length>0 || ifElseAttributeValue===null || ifCaseAttributeValue?.length>0 || ifCaseAttributeValue===null){
			if(!depList){
				depList = new Set();
				// Build list of dependant if states
				for(let e=element.previousSibling; e; e=e.previousSibling){
					let isEl=e instanceof Element, eState=this.#stateMap.get(e);
					if(!eState && !isEl) continue;
					if(!eState && isEl) break;
					if(eState){
						if(eState.ifElseAttributeValue===null || eState.ifCaseAttributeValue===null) break; // Empty if-else or if-case
						depList.add(eState);
						if(eState.ifAttributeValue?.length>0 || eState.ifMatchAttributeValue?.length>0) break; // Specified if or if-match
						if(e===eState.tplAnchorEnd) e = eState.tplAnchorStart;
					}
				}
				state.depList = depList;
			}
			// Check if states
			for(let s of depList) if(s.exec && s.showing){ result=false; break; }
			if((ifElseAttributeValue===null || ifCaseAttributeValue===null) && result===null){ result = true; } // Empty if-else or if-case
		}
		// Setup signalObserver
		if(!signalObs){
			let self=this; signalObs = state.signalObs = (signalObs || state.signalCtrl.createObserver());
			signalObs.addListener(function pluginIf_signalObserver(){
				let updateIndex = state.updateIndex;
				self.ScopeDom.animFrameHelper.onceRAF(state,signalObs,function pluginIf_signalObserver_RAF(){
					if(state.updateIndex!==updateIndex) return;
					signalObs.clearSignals();
					self.#runIfExpressions(plugInfo,attrib,state,expression,performMatch,true);
				});
			});
		}
		// Build Exec for On Show / On Hide - no signalObserver for these
		if(onShowEvent?.length>0 && !state.onShowExec) state.onShowExec = this.#executeExpression(element,onShowEvent,false);
		if(onHideEvent?.length>0 && !state.onHideExec) state.onHideExec = this.#executeExpression(element,onHideEvent,false);
		// Build / Run Expression
		if(result===null){
			let execExtra = null;
			if(expression?.length>0 && ifCaseAttributeValue?.length>0 && ifCaseAttributeValue===expression) execExtra = matchCaseScope;
			if(!exec) exec = state.exec = this.#executeExpression(element,expression,true,execExtra,signalObs);
			result = element.$ifResult = exec.runFn();
		}
		this.#handleResult(plugInfo,attrib,state,expression,updateIndex,performMatch,updateDependents,result);
	}
	
	/**
	 * Processes conditional rendering results after an expression has been evaluated.
	 * 
	 * This method handles:
	 * 1. Signal resolution and promise handling (deferred processing via RAF).
	 * 2. `if-match` / `if-case` match evaluation logic with recursive matching support.
	 * 3. Promise-based expressions use a default value until resolved, then re-triggers `#handleResult`.
	 * 4. Delegation to `#handleTemplateIfResult()` or `#handleRegularIfResult()` based on template mode.
	 * 
	 * @param {Object} plugInfo - Contains element and scope control info
	 * @param {Object} attrib - Attribute descriptor for this element (used in result handling)
	 * @param {Object} state - Current conditional rendering state
	 * @param {string|null} expression - Expression string to evaluate, or null if none was provided
	 * @param {number} updateIndex - The current update index; older results are ignored if a newer one exists
	 * @param {boolean} performMatch - Match-case evaluation logic should be performed (default: true)
	 * @param {boolean} updateDependents - Dependent sibling elements should also receive updates (default: false)
	 * @param {*} result - The evaluated expression result to process
	 * @private
	 */
	#handleResult(plugInfo,attrib,state,expression,updateIndex,performMatch,updateDependents,result){
		let { signalObs, ifAttributeValue, ifElseAttributeValue, ifMatchAttributeValue, ifCaseAttributeValue, isTemplate, execMatch, options:{ matchOnce, defaultValue } } = state;
		// Ignore old results
		if(state.updateIndex>updateIndex) return;
		// Resolve Signal
		result = this.ScopeDom.resolveSignal(result,signalObs);
		// If result is promise, use default & handleResult when settled
		if(result instanceof Promise){
			// Fallback / Default Value
			this.#handleResult(plugInfo,attrib,state,expression,updateIndex,performMatch,false,defaultValue);
			updateIndex = state.updateIndex;
			// Handle Result
			this.ScopeDom.animFrameHelper.promiseToRAF(result,this.#handleResult.bind(this,plugInfo,attrib,state,expression,updateIndex,false,true));
			return;
		}
		// If the match result is a promise that contains a resolved value, ensure updates are propagated to other dependent elements
		if(!updateDependents && execMatch?.result instanceof Promise && Object.hasOwn(execMatch.result,matchCasePromiseResultSymbol)) updateDependents = true;
		// if updateDependents, check depList
		if(updateDependents && state.depList) for(let eState of state.depList) if(eState.showing){ result=false; ifElseAttributeValue=false; ifCaseAttributeValue=false; break; }
		// Handle if-match & if-case
		if(ifCaseAttributeValue?.length>0 && ifCaseAttributeValue===expression){
			let ifMatch = null, matchElement = state.element, matchResult = null, matchOpts = new Map();
			if(!execMatch && state.depList) for(let eState of [state,...state.depList]){
				if(!execMatch && eState.execMatch) execMatch = state.execMatch = eState.execMatch;
				if(eState.ifMatchAttributeValue?.length>0){
					ifMatch = eState.ifMatchAttributeValue;
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
			else if(firstRun || (performMatch!==false && !matchOnce)){
				// console.log({ firstRun, performMatch, matchOnce });
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
						this.#runIfExpressions(plugInfo,attrib,state,expression,false);
					});
				}
			}
			// Check Match Case
			if(result!==false){
				let obsRecording = signalObs && signalObs.startRecording();
				result = this.#matchCase(matchResult,result,signalObs);
				if(obsRecording) signalObs.stopRecording();
			}
		}
		// Continue with result
		if(isTemplate) this.#handleTemplateIfResult(plugInfo,attrib,state,expression,updateIndex,result);
		else this.#handleRegularIfResult(plugInfo,attrib,state,expression,updateIndex,result);
		// if updateDependents, update remaining if elements
		if(updateDependents && !(ifElseAttributeValue===null || ifCaseAttributeValue===null)){
			let anyShowing = !!state.showing;
			for(let e=state.element.nextSibling; e; e=e.nextSibling){
				let isEl=e instanceof Element, eState=this.#stateMap.get(e);
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
	 * @param {*} matchValue - The value to be matched (usually the evaluated expression result)
	 * @param {*} caseValue - The pattern/object against which `matchObj` is compared
	 * @returns {boolean} True if successful match occurred; otherwise, returns false
	 * @private
	 */
	#matchCase(matchValue,caseValue){
		try{
			// Resolve Signals
			matchValue = this.ScopeDom.resolveSignal(matchValue);
			caseValue = this.ScopeDom.resolveSignal(caseValue);
			// Equals
			if(matchValue===caseValue) return true;
			if(typeof caseValue==='string' || typeof caseValue==='number' || typeof caseValue==='boolean') return false;
			if(caseValue===void 0 || caseValue===null || caseValue instanceof Error) return false;
			if(matchValue instanceof Promise || caseValue instanceof Promise) return false;
			// Regex
			if(caseValue instanceof RegExp && typeof matchValue==='string') return caseValue.test(matchValue);
			// Special Function
			if(caseValue instanceof Function && Object.hasOwn(caseValue,matchCaseOperatorSymbol)){
				let operator = caseValue[matchCaseOperatorSymbol];
				let arr = caseValue(matchValue), result = false;
				if(operator==='or'){ result=false; for(let v of arr) if(this.#matchCase(matchValue,v)) return true; }
				else if(operator==='and'){ result=true; for(let v of arr) if(!this.#matchCase(matchValue,v)) return false; }
				else if(operator==='not'){ result=true; for(let v of arr) if(this.#matchCase(matchValue,v)) return false; }
				return result;
			}
			// Function
			if(caseValue instanceof Function) return !!caseValue(matchValue);
			// Map
			if(matchValue instanceof Map || matchValue instanceof WeakMap){
				if(!(caseValue instanceof Map) && typeof caseValue==='object' && caseValue!==null){
					if(Symbol.iterator in caseValue) return false;
					caseValue = new Map(Object.entries(Object(caseValue)));
				}
				if(caseValue instanceof Map){
					for(let [key,value] of caseValue) if(!matchValue.has(key) || !this.#matchCase(matchValue.get(key),value)) return false;
					return true;
				}
			}
			// Array / Iterable
			let isMatchArray = matchValue instanceof Array, isMatchIterable = !isMatchArray && (typeof matchValue==='object' && matchValue!==null && Symbol.iterator in matchValue);
			let isCaseArray = caseValue instanceof Array, isCaseIterable = !isCaseArray && (typeof caseValue==='object' && caseValue!==null && Symbol.iterator in caseValue);
			if((isMatchArray || isMatchIterable) && (isCaseArray || isCaseIterable)){
				if(!isMatchArray && isMatchIterable) matchValue = Array.from(matchValue);
				if(!isCaseArray && isCaseIterable) caseValue = Array.from(caseValue);
				for(let i=0, cl=caseValue.length, ml=matchValue.length; i<cl; i++){
					if(i>=ml) return false;
					if(!this.#matchCase(matchValue[i],caseValue[i])) return false;
				}
				return true;
			}
			// Object
			if(typeof matchValue==='object' && typeof caseValue==='object' && matchValue!==null && caseValue!==null){
				matchValue = Object(matchValue); caseValue = Object(caseValue);
				for(let key of Object.keys(caseValue)) if(!Object.hasOwn(matchValue,key) || !this.#matchCase(matchValue[key],caseValue[key])) return false;
				return true;
			}
		}catch(err){ console.warn('pluginIf: matchCase error:',caseValue,`\n`,err); }
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
	 * @param {string|null} expression - Expression string to evaluate, or null if none was provided
	 * @param {number} callUpdateIndex - The update index at which this handler was called (older calls are ignored)
	 * @param {boolean} nowShowing - Element should currently be shown (`true`) or hidden (`false`)
	 * @private
	 */
	#handleRegularIfResult(plugInfo,attrib,state,expression,callUpdateIndex,nowShowing){
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
		let resultChanged = (wasShowing===null || wasShowing!==nowShowing);
		// While element isn't loaded, fallback to style.display
		if(domRemove && !nowShowing && !isElementLoaded(element)){
			instance.onElementLoaded(element,this.#runIfExpressions.bind(this,plugInfo,attrib,state,expression));
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
				this.#stateMap.set(anchor,state);
				this.instance.cacheConnectedNodes.add(anchor);
			}
			// Show
			if(resultChanged && nowShowing){
				if(anchor.isConnected){
					instance.elementScopeSetAlias(element,anchor);
					anchor.replaceWith(element);
				}
				if(onShowExec) onShowExec.runFn();
			}
			// Hide
			if(resultChanged && !nowShowing){
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
			if(resultChanged && nowShowing){
				element.style.display = defaultDisplay;
				if(onShowExec) onShowExec.runFn();
			}
			if(resultChanged && !nowShowing){
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
	 * @param {string|null} expression - Expression string to evaluate, or null if none was provided
	 * @param {number} callUpdateIndex - The update index at which this handler was called (older calls are ignored)
	 * @param {boolean} nowShowing - Template content should currently be shown (`true`) or hidden (`false`)
	 * @private
	 */
	#handleTemplateIfResult(plugInfo,attrib,state,expression,callUpdateIndex,nowShowing){
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
		let resultChanged = (wasShowing===null || wasShowing!==nowShowing);
		// Don't run while element isn't loaded
		if(!isElementLoaded(element)){ instance.onElementLoaded(element,this.#runIfExpressions.bind(this,plugInfo,attrib,state,expression)); return; }
		// Create Anchors
		if(!tplAnchorStart || !tplAnchorEnd){
			tplAnchorStart = state.tplAnchorStart = state.tplAnchorStart||document.createComment(' If-Start-Anchor: '+element.nodeName+' '+attribute+' '+(expression?.length>0?expression+' ':''));
			tplAnchorEnd = state.tplAnchorEnd = state.tplAnchorEnd||document.createComment(' If-End-Anchor ');
			state.anchor = tplAnchorEnd; // alias, but dont add to stateMap
			this.#stateMap.set(tplAnchorStart,state);
			this.#stateMap.set(tplAnchorEnd,state);
			resultChanged = true;
		}
		// Check if the anchors are still in the DOM; if not, they might have been moved or removed externally
		if(tplAnchorStart.parentNode || tplAnchorEnd.parentNode){
			let correctDOM = false;
			if(tplAnchorStart.parentNode===element.parentNode && tplAnchorStart.parentNode===tplAnchorEnd.parentNode){
				for(let e=tplAnchorStart.nextSibling; e; e=e.nextSibling) if(e===tplAnchorEnd){ correctDOM=true; break; }
			}
			if(!correctDOM){
				console.warn("pluginIf: DOM has been externally modified, correcting DOM structure",element);
				resultChanged = true;
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
		if((resultChanged && !nowShowing) && tplAnchorStart.parentNode && tplAnchorEnd.parentNode){
			let nodes = new Set();
			for(let e=tplAnchorStart.nextSibling; e && e!==tplAnchorEnd; e=e.nextSibling){
				if(!domRemove && e.nodeType===textNodeType) hasDirectTextNodes = true;
				nodes.add(e);
			}
			tplNodes = state.tplNodes = nodes;
		}
		// When showing, if no nodes are saved, clone them from the template element
		if((resultChanged && nowShowing) && (!tplNodes || tplNodes.size===0)){
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
			if(resultChanged && !nowShowing){
				// Remove Nodes
				if(tplNodes?.size>0) for(let n of tplNodes) n.remove();
				// Remove Anchors
				tplAnchorStart.parentNode?.removeChild(tplAnchorStart);
				tplAnchorEnd.parentNode?.removeChild(tplAnchorEnd);
				// Callback on-hide
				if(onHideExec) onHideExec.runFn();
			}
			// Show
			if(resultChanged && nowShowing){
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
			if(resultChanged && !nowShowing){
				if(tplNodes?.size>0) for(let n of tplNodes){
					if(!n.style) continue;
					if(!tplDefaultDisplay.has(n)) tplDefaultDisplay.set(n,n.style.display||'');
					n.style.setProperty('display','none','important');
				}
				if(onHideExec) onHideExec.runFn();
			}
			// Show
			if(resultChanged && nowShowing){
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
