"use strict";

const symbRepeatElementScope = Symbol("pluginRepeatElementScope");

const hasMoveBeforeSupport = 'moveBefore' in Element.prototype && typeof Element.prototype.moveBefore==="function";

/**
 * Plugin for repeating elements based on data iteration.
 * 
 * Key features:
 * - Data iteration with automatic DOM reuse and caching
 * - Scope management with aliasing for repeated contexts
 * - Anchor node system for tracking DOM positions
 * - Signals & Event-driven updates for scope and DOM changes
 * - Support for template elements and other elements
 * - Performance optimization via DOM caching with configurable time limits
 *
 * @class pluginRepeat
 */
export class pluginRepeat {
	
	/**
	 * @returns {string} The name of the plugin.
	 */
	get name(){ return 'repeat'; }
	
	/**
	 * @param {Object} ScopeDom - The ScopeDom class.
	 * @param {Object} instance - The ScopeDom instance.
	 */
	constructor(ScopeDom,instance){
		this.ScopeDom = ScopeDom;
		this.instance = instance;
		this.isElementLoaded = ScopeDom.isElementLoaded;
		this.eventMap = new WeakMap(); // element, set (removeEvent cb)
		this.stateMap = new WeakMap(); // element, state
		this.afterElementDC = new WeakMap(); // element, cb
	}
	
	/**
	 * Called when the plugin is connected to an element.
	 * Sets up repeat logic based on repeat attribute presence and interaction with pluginIf.
	 * 
	 * @param {Object} plugInfo - Information about the plugin connection
	 * @param {HTMLElement} plugInfo.element - The element being connected (may be a template)
	 * @param {Map<string, Object>} plugInfo.attribs - Parsed ScopeDom attributes of the element
	 */
	onConnect(plugInfo){
		let { element, attribs } = plugInfo;
		if(!element.isConnected) return;
		let repeatAttrib, ifAttrib;
		if(attribs?.size>0) for(let [attribName,attrib] of attribs){
			let { nameParts, nameKey, isDefault } = attrib;
			if(nameKey==='repeat') repeatAttrib = attrib;
			if(nameKey==='if') ifAttrib = attrib;
		}
		if(repeatAttrib && ifAttrib) return; // pluginIf will move repeat into child template
		if(repeatAttrib && this._setupRepeat(plugInfo,repeatAttrib)) return;
		if(this.stateMap.has(element)) this._reSetupRepeat(element);
	}
	
	/**
	 * Called when the plugin disconnects from an element.
	 * Cleans up event listeners, signal observers, and removes DOM elements.
	 * 
	 * @param {Object} plugInfo - Information about the plugin connection, contains `element`
	 * @param {HTMLElement} plugInfo.element - The element being disconnected
	 */
	onDisconnect(plugInfo){
		let { element } = plugInfo;
		// Element Swap - If element is being swapped, defer cleanup
		if(this.afterElementDC.has(element)){
			let cb = this.afterElementDC.get(element);
			this.afterElementDC.delete(element);
			Promise.resolve().then(cb);
			return;
		}
		// Get State - Retrieve the repeat state for this element
		let state = this.stateMap.get(element);
		if(!state || !state.ready) return;
		let { signalObs, anchorStart, anchorEnd, elementAnchor, mainTemplate } = state;
		// Skip cleanup if anchors are already properly connected, or element anchor is disconnected without anchors
		if((elementAnchor?.isConnected && !anchorStart && !anchorEnd) || (elementAnchor?.isConnected && anchorStart?.isConnected && anchorEnd?.isConnected)) return; // Eg, if moved
		// Cleanup - Perform async cleanup when anchors are disconnected
		Promise.resolve().then(()=>{
			// Mark as disconnected if any anchor is not connected
			if(!elementAnchor?.isConnected || (anchorStart && !anchorStart?.isConnected) || (anchorEnd && !anchorEnd?.isConnected)) state.connected=false;
			if(state.connected) return;
			// Remove event listeners - for elementAnchor
			if(this.eventMap.has(elementAnchor)){
				let set = this.eventMap.get(elementAnchor);
				for(let removeEvent of set) removeEvent();
				this.eventMap.delete(elementAnchor);
			}
			// Cleanup signalObserver
			if(signalObs){ signalObs.clear(); state.signalObs=null; }
			// Remove State
			if(this.stateMap.has(mainTemplate)) this.stateMap.delete(mainTemplate);
			if(this.stateMap.has(elementAnchor)) this.stateMap.delete(elementAnchor);
			if(this.stateMap.has(anchorStart)) this.stateMap.delete(anchorStart);
			if(this.stateMap.has(anchorEnd)) this.stateMap.delete(anchorEnd);
			// Remove DOM Elements
			let { domArr, anchorArr } = state;
			if(anchorArr?.length>0) for(let i=0,l=anchorArr.length; i<l; i++) anchorArr[i].parentNode?.removeChild(anchorArr[i]);
			if(domArr?.length>0) for(let i=0,l=domArr.length; i<l; i++) domArr[i].parentNode?.removeChild(domArr[i]);
			// Cleanup
			state.itemsArr = state.domArr = state.anchorArr = null;
		});
	}
	
	/**
	 * Re-establishes repeat setup when anchors are reconnected.
	 * Re-registers event listeners and triggers execution.
	 * 
	 * @param {HTMLElement} stateKey - The anchor element whose state needs re-setup
	 * @private
	 */
	_reSetupRepeat(stateKey){
		let { instance } = this;
		let state = this.stateMap.get(stateKey);
		if(!state) return;
		let { options:{ updateEvent, updateDomEvent }, element, scopeCtrl, anchorStart, anchorEnd, elementAnchor, connected:wasConnected } = state;
		if(!state.ready) return;
		let isConnected = anchorStart?.isConnected && anchorEnd?.isConnected && elementAnchor?.isConnected;
		if(wasConnected && isConnected) return;
		state.connected = isConnected;
		if(!isConnected) return;
		// Register Events
		if(!this.eventMap.has(elementAnchor)){
			if(updateEvent?.length>0) this._registerEvent(elementAnchor,scopeCtrl.ctrl.$on(updateEvent,state.triggerExec,{ __proto__:null, capture:false, passive:true },true));
			if(updateDomEvent?.length>0) this._registerEvent(elementAnchor,scopeCtrl.$onDom(updateDomEvent,state.triggerExec,{ __proto__:null, capture:true, passive:true },true));
		}
		// Run Expressions
		state.triggerExec();
	}
	
	/**
	 * Sets up the repeat directive on an element.
	 * 
	 * This is the core method that handles template creation, anchor setup,
	 * option parsing, and state initialization for the repeat functionality.
	 * 
	 * @param {Object} plugInfo - The plugin connection info
	 * @param {Object} attrib - The repeat attribute info
	 * @returns {boolean} true if setup is deferred (waiting for element to load)
	 * @private
	 */
	_setupRepeat(plugInfo,attrib){
		let { ScopeDom, instance, isElementLoaded } = this;
		let { element, elementScopeCtrl, attribs } = plugInfo;
		let { isDefault, attribute, nameKey, nameParts, value } = attrib;
		// Re-use State - If state already exists, re-setup instead
		if(this.stateMap.has(element)) return this._reSetupRepeat(element);
		// Need element to be fully loaded - Defer setup if element not ready
		if(!isElementLoaded(element)){ instance.onElementLoaded(element,this._setupRepeat.bind(this,plugInfo,attrib)); return true; }
		// Fallback value if null
		if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['once','node']);
		// Options - Parse all repeat options
		let attribOpts = instance.elementAttribOptionsWithDefaults(element,attrib);
		let onlyOnce = instance.elementAttribParseOption(element,attribOpts,'once',{ default:false, emptyTrue:true, runExp:true }).value; // $repeat:once
		let updateEvent = instance.elementAttribParseOption(element,attribOpts,'update scope',{ default:'$update', emptyTrue:false, runExp:true }).value; // $repeat:update-scope='event', $emit('event')
		let updateDomEvent = instance.elementAttribParseOption(element,attribOpts,'update dom',{ default:'$update', emptyTrue:false, runExp:true }).value; // $repeat:update-dom='event', $emitDom('event')
		let keyName = instance.elementAttribParseOption(element,attribOpts,'key',{ default:'$key', emptyTrue:false, runExp:false }).value; // $repeat:key="$key"
		let itemName = instance.elementAttribParseOption(element,attribOpts,'item',{ default:'$item', emptyTrue:false, runExp:false }).value; // $repeat:item="$item"
		let scopeName = instance.elementAttribParseOption(element,attribOpts,'scope',{ default:null, emptyTrue:false, runExp:false }).value; // $repeat:scope="$repeat1"
		let useElement = instance.elementAttribParseOption(element,attribOpts,'use',{ default:null, emptyTrue:false, runExp:true });
		let includeNode = instance.elementAttribParseOption(element,attribOpts,'node',{ default:false, emptyTrue:true, runExp:true }).value;
		let onUpdateEvent = instance.elementAttribParseOption(element,attribOpts,'on update',{ default:null, emptyTrue:false, runExp:false }).value; // $repeat:on-update
		let cacheList = instance.elementAttribParseOption(element,attribOpts,'cache',{ default:1, emptyTrue:false, runExp:true }).value;
		cacheList = parseFloat(cacheList)*1000; if(cacheList+''==='NaN' || cacheList<0) cacheList = 0;
		// New State
		let mainTemplate, fromElement, fromElementAnchor, fromElementConnected, elementChildren, anchorStart, anchorEnd, createAnchorAfter, elementAnchor=element;
		let state = { __proto__:null,
			signalCtrl: elementScopeCtrl.ctrl.signalCtrl, signalObs:null,
			options:{ __proto__:null, onlyOnce, keyName, itemName, scopeName, updateEvent, updateDomEvent, onUpdateEvent, cacheList },
			mainTemplate:null, anchorStart:null, anchorEnd:null, elementAnchor, element, scopeCtrl:elementScopeCtrl, domCache:new WeakMap(),
			exec:null, connected:true, ready:false, itemsArr:null, domArr:null, anchorArr:null, triggerExec:null, onUpdateExec:null, updateIndex:0,
		};
		// Prepare the trigger execution function
		let triggerExec = state.triggerExec = this._runExpressions.bind(this,plugInfo,state,value);
		// Create end anchor comment
		let commentEnd = document.createComment(' Repeat-End-Anchor: '+value+' ');
		// <any $repeat:use="element"> Handle use attribute pointing to external element
		if(useElement.attribOption){
			let needsResolving = (useElement.execResult instanceof Error || useElement.value===null || (typeof useElement.value==="string" && useElement.value.length>0));
			useElement = this.ScopeDom.resolveSignal(useElement.value);
			// Handle string selector
			if(needsResolving){
				if(typeof useElement==="string") useElement = element.ownerDocument.querySelector(useElement);
				// Defer if main element not loaded
				if(!(useElement instanceof Node) && !isElementLoaded(instance.mainElement)){
					instance.onElementLoaded(instance.mainElement,this._setupRepeat.bind(this,plugInfo,attrib)); return true;
				}
			}
			if(!(useElement instanceof Node)) console.warn("pluginRepeat: repeat:use missing element,",element);
			// Defer if use element not loaded
			if(useElement && !isElementLoaded(useElement)){
				instance.onElementLoaded(useElement,this._setupRepeat.bind(this,plugInfo,attrib)); return true;
			}
			// Prevent self-referencing use element
			if(useElement.nodeName!=='TEMPLATE') for(let e=useElement; e; e=e?.parentNode) if(e===element){ useElement=null; break; }
			if(useElement){
				if(useElement.nodeName==='TEMPLATE') mainTemplate = useElement;
				else {
					// Insert from-anchor and mark element for template creation
					useElement.parentNode.insertBefore(fromElementAnchor=document.createComment(' Repeat-From-Anchor '),useElement);
					fromElement = useElement;
				}
				element.appendChild(anchorEnd=commentEnd);
			}
		}
		// <template $repeat> Template element as repeat source
		if(!mainTemplate && !fromElement && element.nodeName==='TEMPLATE'){
			mainTemplate = element;
			createAnchorAfter = element;
		}
		// <any $repeat><template> Child template element
		if(!mainTemplate && !fromElement && element.childElementCount===1 && element.children[0]?.nodeName==='TEMPLATE'){
			mainTemplate = element.children[0];
			element.appendChild(anchorEnd=commentEnd);
		}
		// <any $repeat $repeat:node> Include node option
		if(!mainTemplate && !fromElement && includeNode){
			fromElement = element;
			createAnchorAfter = element;
		}
		// <any $repeat> Default case - clone children
		if(!mainTemplate && !fromElement && !includeNode){
			fromElement = element;
			// Clone children to document fragment
			elementChildren = document.createDocumentFragment();
			for(let e of [...element.childNodes]) elementChildren.appendChild(e);
			element.appendChild(anchorEnd=commentEnd);
		}
		// Create Anchors - Insert anchor comments into DOM
		if(createAnchorAfter){
			element.parentNode.insertBefore(anchorEnd=commentEnd,element.nextSibling);
		}
		// Create start anchor if not already created
		if(anchorEnd && !anchorStart){
			anchorEnd.parentNode.insertBefore(anchorStart=document.createComment(' Repeat-Start-Anchor: '+value+' '),anchorEnd);
		}
		// Remove fromElement & Create template if ready
		if(!mainTemplate && fromElement && !elementChildren){
			fromElementConnected = fromElement.isConnected;
			fromElement.remove();
			if(!fromElementConnected) this._createTemplateFromElement(state,{ __proto__:null, fromElement, fromElementAnchor, includeNode, attribute, attribOpts });
			mainTemplate = state.mainTemplate;
		}
		// Finalize State
		if(mainTemplate && !(mainTemplate.content?.childNodes?.length>0)){ console.warn("pluginRepeat: template has no content"); return; }
		if(mainTemplate) state.mainTemplate = mainTemplate;
		state.anchorStart = anchorStart;
		state.anchorEnd = anchorEnd;
		this.stateMap.set(anchorStart,state);
		this.stateMap.set(anchorEnd,state);
		// Continue when ready
		function finishSetupPluginRepeat(){
			// Complete template setup if deferred
			if(!mainTemplate && fromElement && fromElementConnected){
				this._createTemplateFromElement(state,{ __proto__:null, fromElement, includeNode, fromElementAnchor, attribute, attribOpts });
				mainTemplate = state.mainTemplate;
				if(!fromElement.isConnected) elementAnchor = state.elementAnchor = mainTemplate;
			}
			// Create template from cloned children
			else if(!mainTemplate && elementChildren){
				mainTemplate = state.mainTemplate = document.createElement('template');
				mainTemplate.content.appendChild(elementChildren);
				anchorStart.parentNode.insertBefore(mainTemplate,anchorStart);
			}
			// Additional Anchors
			if(!elementAnchor?.isConnected && mainTemplate?.isConnected) elementAnchor = mainTemplate;
			if(mainTemplate.parentNode===element) this.stateMap.set(mainTemplate,state);
			// Fallback elementAnchor - Use anchorStart as fallback
			if(useElement===mainTemplate || mainTemplate.parentNode!==anchorStart.parentNode) elementAnchor = anchorStart;
			// Set up scope aliasing
			if(elementAnchor!==element) instance.elementScopeSetAlias(elementAnchor,element,true);
			// Mark state as ready
			state.ready = true;
			state.elementAnchor = elementAnchor;
			this.stateMap.set(elementAnchor,state);
			state.scopeCtrl = instance.elementScopeCtrl(elementAnchor);
			// Check Connected - Verify anchor connectivity
			if(!anchorStart.isConnected || !anchorEnd.isConnected || !elementAnchor.isConnected){ state.connected=false; }
			if(state.connected){
				// Add $repeat() to element & element context
				state.scopeCtrl.execContext.$repeat = elementAnchor.$repeat = triggerExec;
				// Register Events
				if(updateEvent?.length>0) this._registerEvent(elementAnchor,state.scopeCtrl.ctrl.$on(updateEvent,triggerExec,{ __proto__:null, capture:false, passive:true },true));
				if(updateDomEvent?.length>0) this._registerEvent(elementAnchor,state.scopeCtrl.$onDom(updateDomEvent,triggerExec,{ __proto__:null, capture:true, passive:true },true));
			}
			// Execute initial expressions
			this._runExpressions(plugInfo,state,value);
		};
		// Schedule setup completion
		if(fromElement && fromElementConnected) this.afterElementDC.set(fromElement,finishSetupPluginRepeat.bind(this));
		else instance.onReady(finishSetupPluginRepeat.bind(this),false);
		return true;
	}
	
	/**
	 * Creates a template from a source element when the original element is removed.
	 * Clones the element, creates a new template, and transfers attributes.
	 * 
	 * @param {Object} state - The repeat state object
	 * @param {Object} options - Template creation options
	 * @param {HTMLElement} options.fromElement - The source element to clone
	 * @param {boolean} options.includeNode - Include the node itself in the template
	 * @param {Comment} options.fromElementAnchor - The anchor comment to position the element
	 * @param {Object} options.attribute - The repeat attribute object
	 * @param {Map} options.attribOpts - Parsed attribute options
	 * @private
	 */
	_createTemplateFromElement(state,{ __proto__=null, fromElement, includeNode, fromElementAnchor=null, attribute, attribOpts }){
		let { mainTemplate, anchorStart } = state;
		if(mainTemplate || !fromElement) return;
		this.stateMap.delete(fromElement);
		let newElement = fromElement.cloneNode(true);
		if(fromElementAnchor){
			fromElementAnchor.parentNode.insertBefore(fromElement,fromElementAnchor);
			fromElementAnchor.remove();
		}
		anchorStart.parentNode.insertBefore(document.createComment(' Repeat-Use: '+(newElement.cloneNode(false).outerHTML||'Node: '+newElement.textContent)+' '),anchorStart);
		mainTemplate = state.mainTemplate = document.createElement('template');
		this.stateMap.set(mainTemplate,state);
		if(includeNode) mainTemplate.content.appendChild(newElement);
		else for(let e of [...newElement.childNodes]) mainTemplate.content.appendChild(e);
		if(includeNode){
			this.ScopeDom.setAttribute(mainTemplate,attribute,newElement.getAttribute(attribute)||'');
			newElement.removeAttribute(attribute);
			for(let [n,opt] of attribOpts) if(opt.attribute && !opt.isDefault){
				if(!mainTemplate.hasAttribute(opt.attribute)) this.ScopeDom.setAttribute(mainTemplate,opt.attribute,opt.value||'');
				newElement.removeAttribute(opt.attribute);
			}
			if(newElement.id?.length>0){
				mainTemplate.id = newElement.id;
				newElement.removeAttribute('id');
			}
		}
		anchorStart.parentNode.insertBefore(mainTemplate,anchorStart);
	}
	
	/**
	 * Registers an event removal callback for an element.
	 * Adds the callback to the event map for cleanup later.
	 * 
	 * @param {HTMLElement} element - The element to register the event for
	 * @param {Function} removeEvent - The event removal callback
	 * @private
	 */
	_registerEvent(element,removeEvent){
		if(!this.eventMap.has(element)) this.eventMap.set(element,new Set());
		this.eventMap.get(element).add(removeEvent);
	}
	
	/**
	 * Executes an expression and returns an execution object.
	 * Optionally wraps the execution function with signal observation.
	 * 
	 * @param {Object} plugInfo - The plugin connection info
	 * @param {string} exp - The expression to execute
	 * @param {boolean} useReturn - Use the return value
	 * @param {Object} extra - Extra data to merge into the scope
	 * @param {Object} signalObs - Optional signal observer to wrap the execution
	 * @returns {Object|null} The execution object or null if expression is empty
	 * @private
	 */
	_execExpression(plugInfo,exp,useReturn=true,extra=null,signalObs=null){
		if(!(exp?.length>0)) return null;
		let exec = this.instance.elementExecExp(plugInfo.elementScopeCtrl,exp,{ __proto__:null, $expression:exp, ...extra },{ silentHas:true, useReturn, run:false });
		if(signalObs) exec.runFn = signalObs.wrapRecorder(exec.runFn);
		return exec;
	}
	
	/**
	 * Runs expressions for the repeat directive, handling signal observation,
	 * expression execution, and triggering DOM updates.
	 * 
	 * @param {Object} plugInfo - The plugin connection info
	 * @param {Object} state - The repeat state object
	 * @param {string} exp - The expression to execute
	 * @private
	 */
	_runExpressions(plugInfo,state,exp){
		let { instance } = this;
		let { signalObs, options, mainTemplate, elementAnchor, anchorStart, anchorEnd, exec, connected, ready, updateIndex } = state;
		let { onlyOnce, onUpdateEvent } = options;
		// Early exit if not ready or not connected
		if(!ready || !connected) return;
		// Early exit if only-once mode
		if(onlyOnce && exec) return;
		// Check that anchors are still in the same parent
		if(anchorStart.parentNode!==anchorEnd.parentNode){ console.warn("pluginRepeat: Repeat Anchors have been modified, cannot run expressions.",{ mainTemplate, elementAnchor, anchorStart, anchorEnd, exp }); return; }
		// Only run if anchors are connected
		if(!anchorStart.isConnected || !anchorEnd.isConnected || !elementAnchor.isConnected) return;
		// Build Exec for On Update - Prepare the on-update callback if configured
		if(onUpdateEvent?.length>0 && !state.onUpdateExec) state.onUpdateExec = this._execExpression(plugInfo,onUpdateEvent,false,null);
		// Setup signalObserver - Re-trigger expressions when signals change
		if(!signalObs){
			let self=this; signalObs = state.signalObs = (signalObs || state.signalCtrl.createObserver());
			signalObs.addListener(function pluginRepeat_signalObserver(){
				let updateIndex = state.updateIndex;
				self.ScopeDom.animFrameHelper.onceRAF(state,signalObs,function pluginRepeat_signalObserver_RAF(){
					// Only run expressions if updateIndex is still the same
					if(state.updateIndex!==updateIndex) return;
					signalObs.clearSignals();
					self._runExpressions(plugInfo,state,exp);
				});
			});
		}
		// Get Items - Prepare the expression execution if not already done
		if(!exec) state.exec = exec = this._execExpression(plugInfo,exp,true,null,signalObs);
		let execResult = exec.runFn();
		// Resolve any signal references in the result
		execResult = this.ScopeDom.resolveSignal(execResult);
		// Handle fallback when Promise on first update
		if(state.itemsArr===null && execResult instanceof Promise){
			this._handleRepeatDOM(plugInfo,state,updateIndex,[]);
			updateIndex = state.updateIndex;
		}
		// Handle Result - If Promise, defer DOM handling to when it resolves; otherwise handle immediately
		if(execResult instanceof Promise) this.ScopeDom.animFrameHelper.promiseToRAF(execResult,this._handleRepeatDOM.bind(this,plugInfo,state,updateIndex));
		else this._handleRepeatDOM(plugInfo,state,updateIndex,execResult);
	}
	
	/**
	 * Handles DOM rendering for repeat directives.
	 * 
	 * Such as:
	 * - Item detection and reuse from previous items
	 * - DOM caching with time-based expiration
	 * - Scope setup for each repeated item
	 * - Efficient DOM diffing and patching
	 * 
	 * @param {Object} plugInfo - The plugin connection info
	 * @param {Object} state - The repeat state object
	 * @param {number} callUpdateIndex - The update index to ignore older calls
	 * @param {*} execResult - The result to iterate over
	 * @private
	 */
	_handleRepeatDOM(plugInfo,state,callUpdateIndex,execResult){
		let { instance } = this;
		let { element } = plugInfo;
		let { options, mainTemplate, elementAnchor, anchorStart, anchorEnd, itemsArr:oldItemsArr, domArr:oldDomArr, anchorArr:oldAnchorArr, domCache, updateIndex } = state;
		let { keyName, itemName, scopeName, cacheList:cacheLimit } = options;
		// Ignore old calls
		if(updateIndex>callUpdateIndex) return;
		state.updateIndex++;
		// Update state: Store the result in both element and anchor for external access
		element.$repeatResult = elementAnchor.$repeatResult = execResult;
		// Resolve signal references in the result
		execResult = this.ScopeDom.resolveSignal(execResult);
		// Convert list into entries [[key,value],...]: Normalize various data types (Map, Set, Array, iterable) to entries
		let itemsArr = [], domArr = [], anchorArr = [], isArr=false;
		if(execResult instanceof Map){ itemsArr=Object.entries(execResult); }
		else if(execResult instanceof Set){ itemsArr=Object.entries([...execResult]); isArr=true; }
		else if(execResult instanceof Array){ itemsArr=Object.entries(execResult); isArr=true; }
		else if(Symbol.iterator in Object(execResult)){ itemsArr=Object.entries([...execResult]); isArr=true; }
		else if(Object(execResult)===execResult){ itemsArr=Object.entries(execResult); }
		else { execResult=[]; itemsArr=[]; isArr=true; }
		// Try to match old DOM/anchors to new items for reuse
		if(!oldItemsArr) oldItemsArr=[]; if(!oldDomArr) oldDomArr=[]; if(!oldAnchorArr) oldAnchorArr=[];
		for(let i=0,l=itemsArr.length; i<l; i++){
			let [key,item] = itemsArr[i];
			let [oldKey,oldItem] = oldItemsArr[i]||[];
			// If item is unchanged (same key and same object reference), reuse old DOM and anchor
			if(oldKey!==void 0 && (isArr || oldKey===key) && oldItem===item){
				domArr[i] = oldDomArr[i];
				anchorArr[i] = oldAnchorArr[i];
				continue;
			}
			// Search for a matching old item that can be reused (not already used)
			if(oldKey!==void 0) for(let j=0,k=oldItemsArr.length; j<k; j++){
				let [oKey,oItem] = oldItemsArr[j];
				if((isArr || oKey===key) && oItem===item && domArr.indexOf(oldDomArr[j])===-1 && anchorArr.indexOf(oldAnchorArr[j])===-1){
					domArr[i] = oldDomArr[j];
					anchorArr[i] = oldAnchorArr[j];
					break;
				}
			}
		}
		// DOM Cache - Set up DOM caching for time-based expiration
		let usableDOMCache = new Map();
		if(cacheLimit>0 && oldItemsArr.length===oldAnchorArr.length){
			// Map current/old DOM positions to their item indices
			let currentDomNodes = [];
			if(oldAnchorArr.length>0) for(let e=anchorStart.nextSibling, i=null; e && e!==anchorEnd; e=e.nextSibling){
				let oai = oldAnchorArr.indexOf(e);
				if(oai!==-1){ i=oai; continue; }
				if(i!==null){
					if(!currentDomNodes[i]) currentDomNodes[i] = [];
					currentDomNodes[i].push(e);
				}
			}
			// Cache current (old) DOM nodes against old items
			let now = Date.now(), itemDomCache = domCache.get(execResult), skipItems = [];
			if(currentDomNodes.length===oldItemsArr.length){
				if(!itemDomCache) domCache.set(execResult,itemDomCache=new WeakMap());
				for(let i=0,l=currentDomNodes.length; i<l; i++){
					let [key,item] = oldItemsArr[i];
					// Skip if already tracked or non-object item
					if(skipItems.indexOf(item)!==-1 || Object(item)!==item) continue;
					let nodes = currentDomNodes[i];
					// Cache if not already cached; otherwise skip (duplicate items)
					if(!usableDOMCache.has(item)){
						itemDomCache.set(item,[now,nodes]);
						usableDOMCache.set(item,nodes);
					} else {
						// Multiple of same item in array, so Skip & Remove nodes from cache
						skipItems.push(item);
						itemDomCache.delete(item);
						usableDOMCache.delete(item);
					}
				}
			}
			// Find re-usable DOM Nodes in cache (within time limit)
			if(itemDomCache) for(let i=0,l=itemsArr.length; i<l; i++){
				let [key,item] = itemsArr[i];
				if(!usableDOMCache.has(item)){
					if(itemDomCache.has(item)){
						let [ts,nodes] = itemDomCache.get(item);
						if(now-ts<=cacheLimit) usableDOMCache.set(item,nodes);
						else itemDomCache.delete(item);
					}
				}
			}
		}
		// Prepare scope data and expected DOM structure for rendering
		let eScopes = instance.elementExtraScopes;
		let expectedDOM = new Set();
		let usedNodes = new Set(), usedAnchors = new Set();
		for(let i=0,l=itemsArr.length; i<l; i++){
			let [key,item] = itemsArr[i];
			// Reuse cached DOM nodes if available, otherwise use old DOM
			let nodes = usableDOMCache.get(item);
			if(!nodes || nodes.length===0) nodes = domArr[i];
			let anchor = anchorArr[i];
			// Only use nodes & anchors once
			if(nodes && usedNodes.has(nodes)) nodes = null;
			if(anchor && usedAnchors.has(anchor)) anchor = null;
			// Dom Nodes - If no reusable nodes, clone from template
			if(!nodes || nodes.length===0){
				nodes = [...mainTemplate.content.cloneNode(true).childNodes];
				// Alias node scopes to elementAnchor for cloned nodes
				if(anchorStart.parentNode!==elementAnchor) for(let e of nodes) instance.elementScopeSetAlias(e,elementAnchor);
			}
			domArr[i] = nodes;
			// Anchor - Create or update anchor comment node
			let anchorData = ' Repeat-Item-Anchor: '+(isArr?'Index '+key:'Key '+key)+' ';
			if(!anchor) anchor = document.createComment(anchorData);
			else if(anchor.data!==anchorData) anchor.data = anchorData;
			anchorArr[i] = anchor;
			// Mark as used
			usedNodes.add(nodes);
			usedAnchors.add(anchor);
			// Set Element Scopes - Build local element scope with iteration metadata
			let [$prevKey,$prevItem] = itemsArr[i-1]||[], [$nextKey,$nextItem] = itemsArr[i+1]||[];
			let scope = { __proto__:null, $index:i, $isFirst:i===0, $isLast:i===l-1, [keyName]:key, [itemName]:item, $prevKey, $prevItem, $nextKey, $nextItem };
			// if(scopeName!==null && scopeName?.length>0) scope = { __proto__:null, [scopeName]:scope }; // $repeat:scope="$repeat1" // $repeat1.$item
			scope[symbRepeatElementScope] = elementAnchor;
			anchor[symbRepeatElementScope] = elementAnchor;
			// Apply scope to anchor element and alias scope on node elements
			for(let e of [anchor,...nodes]){
				let scopesArr = eScopes.get(e)||[], scopeIndex = -1;
				for(let i=0,l=scopesArr.length; i<l; i++){
					let s = scopesArr[i];
					if(s[symbRepeatElementScope]!==elementAnchor) continue;
					if(e===anchor){
						if(scope[scopeName] && s[scopeName]) Object.assign(s[scopeName],scope[scopeName]);
						else Object.assign(s,scope); // Update existing scope, use assign, so references remain correct
					}
					else scopesArr[i] = anchor; // Alias to anchor's element scope
					scopeIndex = i;
					break;
				}
				if(scopeIndex===-1){ scopesArr.unshift(scope); scopeIndex=0; } // Add new scope
				if(elementAnchor!==e.parentNode){
					let eaIndex = scopesArr.length>1 ? scopesArr.indexOf(elementAnchor) : -1; // Find elementAnchor
					if(eaIndex!==-1 && eaIndex!==scopeIndex+1){ scopesArr.splice(eaIndex,1); eaIndex=-1; } // Remove elementAnchor
					if(eaIndex===-1) scopesArr.splice(scopeIndex+1,0,elementAnchor); // Add elementAnchor after scopeIndex
				}
				if(!eScopes.has(e)) eScopes.set(e,scopesArr); // Save element scopes
			}
			// Add to expected DOM
			expectedDOM.add(anchor);
			for(let e of nodes) expectedDOM.add(e);
		}
		// Quick-Morph live DOM with expected DOM
		let expectedArr=[...expectedDOM], foundDOM=new Set();
		// Collect currently existing DOM nodes between anchors
		for(let e=anchorStart.nextSibling; e && e!==anchorEnd; e=e.nextSibling) foundDOM.add(e);
		let foundArr = [...foundDOM], fIndex=0, tmpFragment=document.createDocumentFragment();
		// Iterate through expected DOM in order, reconciling with found DOM
		for(let i=0,l=expectedArr.length; i<l; i++){
			let expected = expectedArr[i];
			let found = foundArr[fIndex];
			// Find moved element and remove intermediate old DOM
			if(found && found!==expected){
				let foundAt = foundArr.indexOf(expected);
				if(foundAt>fIndex){
					let oldFI = fIndex;
					found = foundArr[fIndex=foundAt];
					// Remove intermediate DOM nodes that are no longer needed
					for(let j=oldFI; j<fIndex; j++){
						if(!hasMoveBeforeSupport || !expectedDOM.has(foundArr[j])){
							foundArr[j].parentNode?.removeChild(foundArr[j]);
						}
					}
				}
			}
			// Remove old DOM if not in expected set
			if(found && found!==expected){
				if(!hasMoveBeforeSupport || !expectedDOM.has(found)) found.parentNode?.removeChild(found);
				fIndex++;
			}
			// Insert expected & buffered DOM nodes
			if(found===expected){
				if(tmpFragment.childNodes.length>0){
					found.parentNode.insertBefore(tmpFragment,found);
					tmpFragment = document.createDocumentFragment();
				}
				fIndex++;
			}
			// Buffer DOM nodes
			else if(!hasMoveBeforeSupport || !expected.isConnected) tmpFragment.appendChild(expected);
		}
		// Clean up any remaining old DOM nodes
		if(fIndex<foundArr.length){
			for(let i=fIndex,l=foundArr.length; i<l; i++){
				if(!hasMoveBeforeSupport || !expectedDOM.has(foundArr[i])){
					foundArr[i].parentNode?.removeChild(foundArr[i]);
				}
			}
		}
		// Insert any buffered DOM nodes
		if(tmpFragment.childNodes.length>0) anchorEnd.parentNode.insertBefore(tmpFragment,anchorEnd);
		// Finalize DOM node placement using moveBefore for efficient reordering
		if(hasMoveBeforeSupport){
			for(let i=expectedArr.length-1; i>=0; i--){
				let expected = expectedArr[i], after = expectedArr[i+1] || anchorEnd;
				if(expected.parentNode!==anchorEnd.parentNode || expected.nextSibling!==after){
					if(!expected.isConnected) anchorEnd.parentNode.insertBefore(expected,after);
					else anchorEnd.parentNode.moveBefore(expected,after);
				}
			}
		}
		// Update state
		state.itemsArr=itemsArr; state.domArr=domArr; state.anchorArr=anchorArr;
		element.$updated = elementAnchor.$updated = true;
		// On Update Event
		if(state.onUpdateExec) state.onUpdateExec.runFn();
	}
	
}

let win = typeof window!=='undefined' && window;
if(win) win.ScopeDom?.pluginAdd?.(pluginRepeat) || ((win.ScopeDomPlugins=win.ScopeDomPlugins||{}).pluginRepeat=pluginRepeat);
