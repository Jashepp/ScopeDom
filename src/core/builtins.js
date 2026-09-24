
import {
	noopFn,noopAsyncFn,setUnion,disposeSymbol,isPromise,
	microtaskCache,mtCacheGetDefinedProperty,mtCacheDefineProperty,mtCacheGetPrototypeOf,mtCacheSetPrototypeOf,
	regexMatchAll,regexExec,regexTest,regexMatchAllFirstGroup,
	elementNodeType,commentNodeType,textNodeType,
	getPrototypeOf,getOwnPropertyDescriptor,defineProperty,hasOwn,
	objectProto,nodeProto,elementProto,functionProto,functionAsyncProto,nativeProtos,nativeConstructors,
	isNative,scopeAllowed,defineWeakRef,
	setAttribute,eventRegistry,
} from "./utils.js";
import {
	timing,
} from "./timing.js";
import {
	execExpression,execExpressionProxy,
} from "./exec.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal, signalSymb,
} from "./signal.js";
import ScopeDom from "../scopedom.js";

/**
 * Built-in Attributes - central handler for ScopeDom's core reactive attribute features.
 * 
 * The builtinAttributes class is a plugin handler that processes ScopeDom's built-in
 * attributes by dispatching to the appropriate handlers on element connect/disconnect.
 * It is the primary mechanism through which ScopeDom's attribute system (as opposed to
 * the signal system) makes DOM updates reactive.
 * 
 * Supported attributes:
 * - $swap - Element/Template replacement with template contents
 * - $scope / $scope-name - Create new scopes (with optional $scope:isolate)
 * - $connect / $init - Execute expression on element connection (supports :raf, :instant)
 * - $disconnect / $deinit - Execute expression on element disconnection (supports :raf, :instant)
 * - $update / $update-name - Execute expression on ScopeDom update events (before/after)
 * - $class - Class list management via Expression (Array/Set/Map/Object)
 * - $signal-name:watch - Watch signal changes and execute expression
 * - $signal-name:compute - Compute and update signal value from expression
 * - $on-* / $once-* - DOM event listeners from expressions
 * 
 * @class builtinAttributes
 */
export class builtinAttributes {
	
	/**
	 * Built-in attributes handler constructor.
	 *
	 * Stores a reference to the ScopeDom instance for use by all attribute handlers during
	 * element connect/disconnect processing.
	 *
	 * @constructor
	 * @param {ScopeDom} instance The ScopeDom instance this handler is bound to
	 */
	constructor(instance){
		this.instance = instance;
	}
	
	/**
	 * Handle element onConnect for built-in attributes.
	 * 
	 * Dispatches to specialized handler methods based on attribute name parts.
	 * Returns false when $swap is processed (preventing further attribute or plugin processing).
	 * 
	 * @param {HTMLElement} element The element being connected
	 * @param {Map<string,scopeElementAttribDefaults>} attribs Parsed ScopeDom attributes Map
	 * @param {scopeElementController} elementScopeCtrl The scope element controller for the element
	 * @returns {boolean|undefined} false if $swap was processed (skip further attributes/plugins); undefined otherwise
	 */
	onConnect(element,attribs,elementScopeCtrl){
		let instance = this.instance, onReadyQueue = [];
		// Swap
		if(element.nodeName==='TEMPLATE' && attribs.has('swap')){
			this.#attrSwap(element,attribs);
			return false; // Exit early, don't process other attributes or plugins
		}
		// Scope
		let scopeAttrib = attribs.get('scope'), scopeNamedAttrib = attribs.get('scope name');
		if(scopeAttrib || scopeNamedAttrib){
			this.#attrScope(element,elementScopeCtrl,scopeAttrib,scopeNamedAttrib);
		}
		// Other built-in attribs
		for(let [attribName,attrib] of attribs){
			let { nameParts, value } = attrib;
			let [ name, name2 ] = nameParts;
			if(name==='default') continue;
			let options = instance.elementAttribOptionsWithDefaults(element,attrib);
			// Init / Connect
			if(nameParts.length===1 && (name==='init' || name==='connect')){
				this.#attrConnect(element,attrib,elementScopeCtrl,options,onReadyQueue,value);
				continue;
			}
			// Listen for Update Scope
			if((nameParts.length===1 || nameParts.length===2) && name==='update'){
				this.#attrUpdate(element,attrib,elementScopeCtrl,options,name2,value);
				continue;
			}
			// Class Attribute
			if(nameParts.length===1 && name==='class' && value!==null){
				this.#attrClass(element,attrib,elementScopeCtrl,options,value,onReadyQueue);
				continue;
			}
			// Signal Attribute (lowercase keys)
			if(nameParts.length===2 && name==='signal' && name2?.length>0){
				this.#attrSignal(element,attrib,elementScopeCtrl,options,name2,value);
				continue;
			}
			// Events
			if(nameParts.length===2){
				let [ type, eventName ] = nameParts;
				if(type==='on'){ nameParts = [ type,'dom',eventName ]; }
				else if(type==='once'){ nameParts = [ type,'dom',eventName ]; }
			}
			if(nameParts.length===3 && (nameParts[0]==='on' || nameParts[0]==='once')){
				let [ type, target, eventName ] = nameParts;
				this.#attrEvent(element,attrib,elementScopeCtrl,options,type,target,eventName,value);
				continue;
			}
		}
		// Handle onReady queue
		if(onReadyQueue.length>0) instance.onReady(this.#processOnConnectOnReadyQueue.bind(this,onReadyQueue),false);
	}
	
	/**
	 * Execute queued onConnect callbacks during the onReady lifecycle.
	 * 
	 * Called via instance.onReady() to run connect-related expressions for elements
	 * whose attributes required DOM readiness.
	 * 
	 * @param {Array<Function>} queue Queue for deferred callbacks
	 * @private
	 */
	#processOnConnectOnReadyQueue(queue){
		for(let cb of queue) cb.apply(this);
	}
	
	/**
	 * Handle element onDisconnect for built-in attributes.
	 * 
	 * Dispatches to #attrDisconnect for deinit/disconnect attributes only.
	 * 
	 * @param {HTMLElement} element The element being disconnected
	 * @param {Map<string,scopeElementAttribDefaults>} attribs Parsed ScopeDom attributes Map
	 * @param {scopeElementController} elementScopeCtrl The scope element controller for the element
	 */
	onDisconnect(element,attribs,elementScopeCtrl){
		let instance = this.instance;
		for(let [attribName,attrib] of attribs){
			let { nameParts, value } = attrib;
			let [ name ] = nameParts;
			if(name==='default') continue;
			let options = instance.elementAttribOptionsWithDefaults(element,attrib);
			// Handle deinit / disconnect attributes
			if(nameParts.length===1 && (name==='deinit' || name==='disconnect')){
				let options = instance.elementAttribOptionsWithDefaults(element,attrib);
				this.#attrDisconnect(element,attrib,elementScopeCtrl,options);
				continue;
			}
			// Class Attribute
			if(nameParts.length===1 && name==='class' && attrib.value!==null){
				this.#attrClassUndo(element,attrib,elementScopeCtrl,options);
				continue;
			}
		}
	}
	
	/**
	 * <template $swap> content replacement.
	 * 
	 * Replaces the template element with an anchor comment node and registers an onElementLoaded
	 * callback to swap in the template contents (or a wrapper element if $swap has a value).
	 * No other built-in or plugin attributes are processed on the template element.
	 * 
	 * @param {HTMLElement} element The template element to swap
	 * @param {Map<string,scopeElementAttribDefaults>} attribs Parsed ScopeDom attributes Map
	 * @private
	 */
	#attrSwap(element,attribs){
		let anchor = document.createComment(` Template-Swap-Anchor ${this.instance.dev?element.cloneNode(false).outerHTML:''} `);
		this.instance.elementScopeSetAlias(anchor,element);
		element.parentNode.replaceChild(anchor,element);
		this.instance.onElementLoaded(anchor,this.#attrSwap_onElementLoaded.bind(this,element,attribs,anchor));
	}
	
	/**
	 * onElementLoaded callback for $swap.
	 * 
	 * Removes $swap attribute from template, creates replacement element if $swap has a value,
	 * and replaces the anchor comment with either the new element or the template content fragment.
	 * 
	 * @private
	 */
	#attrSwap_onElementLoaded(element,attribs,anchor){
		let swap = attribs.get('swap'), fragment=element.content, dom=fragment;
		element.removeAttribute(swap.attribute);
		if(swap?.value?.length>0){
			dom = document.createElement(swap.value);
			for(let a of element.attributes) dom.attributes.setNamedItem(a.cloneNode(false));
			dom.appendChild(fragment);
		}
		anchor.replaceWith(dom);
	}
	
	/**
	 * $scope attribute handler: inline scope object expression or named controller.
	 * 
	 * Creates a new scope for the element. All children walk up to access this scope.
	 * If $scope:isolate is set, the scope is isolated from parent chains (reachable only via $scopeParent/$scopeTop).
	 * The expression is evaluated in the parent scope context so it can reference parent variables.
	 * $scopeElement is injected into the scope for self-reference.
	 * 
	 * @private
	 * @param {HTMLElement} element The element to attach the scope to
	 * @param {scopeElementController} elementScopeCtrl The current element scope controller
	 * @param {scopeElementAttribDefaults|null} scopeAttrib The inline $scope attribute definition
	 * @param {scopeElementAttribDefaults|null} scopeNamedAttrib The $scope-name attribute definition
	 */
	#attrScope(element,elementScopeCtrl,scopeAttrib,scopeNamedAttrib){
		let instance = this.instance;
		if(scopeAttrib && scopeNamedAttrib && scopeNamedAttrib.options.size>0) scopeAttrib.options = new Map([...scopeAttrib.options,...scopeNamedAttrib.options]);
		if(!scopeAttrib) scopeAttrib = scopeNamedAttrib;
		let options = instance.elementAttribOptionsWithDefaults(element,scopeAttrib);
		if(scopeAttrib.value===null) instance.elementAttribFallbackOptionValue(scopeAttrib,['isolate']);
		let isolated = options.get('isolate'), { value, attribute:$attribute } = scopeAttrib; // After fallback
		let exp = value, extra = { __proto__:null, $attribute }, expOpts = { __proto__:null, run:true, useReturn:true }, ctrlFn;
		// Prepare Named Scope
		if(scopeNamedAttrib){
			if(scopeNamedAttrib.value?.length>0) value = scopeNamedAttrib.value;
			let name = value, ctrl = instance.namedControllers.get(name);
			if(!ctrl){ console.warn(`ScopeDom: scopeController "${name}" doesn't exist`); return; }
			if(ctrl.element && ctrl.element!==element){ console.warn(`ScopeDom: scopeController "${name}" is already in use`,{ ctrlElement:ctrl.element, newElement:element }); return; }
			ctrl.element = element;
			ctrlFn = ctrl.fn;
			extra = { __proto__:null, ...extra };
			exp = `{ __proto__:null, $scopeElement:$this }`;
		}
		// New Scope
		if(exp!==null){
			// Run new scope expression normally, with parent scope
			let { result } = instance.elementExecExp(elementScopeCtrl,exp,extra,expOpts);
			result = result ? Object(result) : void 0;
			let originalScopeCtrl = elementScopeCtrl; // Use originalScopeCtrl as $scopeParent
			if(isolated) instance.elementIsolatedScopes.add(element);
			if(isolated) elementScopeCtrl = instance.elementNewIsolatedScopeCtrl(element,result||void 0,originalScopeCtrl,true);
			else elementScopeCtrl = instance.elementNewScopeCtrl(element,result||void 0,originalScopeCtrl,true);
		}
		// Run Named Scope Controller
		if(scopeNamedAttrib){
			expOpts = { __proto__:null, ...expOpts, fnThis:null, useReturn:false }; // fnThis:null sets 'this' as proxy
			exp = `instance.handleScopeCtrlFn(this,ctrlFn);`;
			instance.elementExecExp(elementScopeCtrl,exp,{ __proto__:null, instance, ctrlFn },expOpts);
		}
	}
	
	/**
	 * $connect or $init attribute handler: run expression on element connection.
	 * 
	 * Compiles the expression into a connectCB and defers execution via timing based on options.
	 * :raf defers to RAF, :instant runs immediately, otherwise uses deferTask.
	 * 
	 * @private
	 * @param {HTMLElement} element The element being connected
	 * @param {scopeElementAttribDefaults} attrib The $connect attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {Array<Function>} onReadyQueue Queue for deferred onReady callbacks
	 * @param {string|null} [value] Expression value from the attribute
	 */
	#attrConnect(element,attrib,elementScopeCtrl,options,onReadyQueue,value){
		if(value===null) value = this.instance.elementAttribFallbackOptionValue(attrib,['raf','instant']);
		let { attribute:$attribute } = attrib;
		let raf = options.get('raf'), instant = options.get('instant');
		if(value?.length>0){
			let { runFn:connectCB } = this.instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
			onReadyQueue.push(this.#attrConnect_onReady.bind(this,element,$attribute,raf,instant,connectCB));
		}
	}
	
	/**
	 * Execute connect expression with timing defer based on :raf/:instant options.
	 * 
	 * @private
	 * @param {HTMLElement} element The element
	 * @param {string} $attribute Original attribute name
	 * @param {ScopeDomAttribOption|null} raf :raf option value
	 * @param {ScopeDomAttribOption|null} instant :instant option value
	 * @param {Function} connectCB Compiled expression function
	 */
	#attrConnect_onReady(element,$attribute,raf,instant,connectCB){
		if(raf && !timing.isDuringRAF) timing.onceAnimation(element,$attribute,connectCB);
		else if(instant) connectCB();
		else timing.deferTask(connectCB);
	}
	
	/**
	 * $disconnect or $deinit attribute handler: run expression on element disconnection.
	 * 
	 * Compiles the expression into a disconnectCB and defers execution via timing based on options.
	 * :raf defers to RAF, :instant runs immediately, otherwise uses deferTask.
	 * 
	 * @private
	 * @param {HTMLElement} element The element being disconnected
	 * @param {scopeElementAttribDefaults} attrib The $disconnect attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 */
	#attrDisconnect(element,attrib,elementScopeCtrl,options){
		let { value, attribute:$attribute } = attrib;
		if(value===null) value = this.instance.elementAttribFallbackOptionValue(attrib,['raf','instant']);
		let raf = options.get('raf'), instant = options.get('instant');
		if(value?.length>0){
			let { runFn:disconnectCB } = this.instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
			if(raf && !timing.isDuringRAF) timing.requestAnimation(disconnectCB);
			else if(instant || timing.isDuringRAF) disconnectCB();
			else timing.deferTask(disconnectCB);
		}
	}
	
	/**
	 * $update or $update-name attribute handler: run expression on scope update events.
	 * 
	 * If a name suffix is present (eg, $update-customword), the expression runs on
	 * $update('customword') events. If $update:before or $update:after options are set,
	 * they determine whether the event is dispatched before or after the main update.
	 * 
	 * @private
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $update attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string|null} [name2] Optional name suffix for scoped updates
	 * @param {string|null} [value] Expression value from the attribute
	 */
	#attrUpdate(element,attrib,elementScopeCtrl,options,name2,value){
		let suffix = null;
		if(value===null){
			value = this.instance.elementAttribFallbackOptionValue(attrib,['before','after']);
			if(options.get('before')) suffix = ':before';
			if(options.get('after')) suffix = ':after';
		}
		if(value?.length>0){
			let { attribute:$attribute } = attrib;
			let { runFn:updateCB } = this.instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
			// Register events straight away
			let evt = '$update'+(name2?.length>0?'-'+name2:'')+(suffix!==null?suffix:'');
			let removeListener = elementScopeCtrl.ctrl.$on(evt,updateCB,{},true);
			this.instance.registerElementRelatedEvent(element,removeListener);
		}
	}
	
	/**
	 * $class attribute handler: append/update class list from expression result.
	 * 
	 * Creates a signalObserver to track the expression's reactivity. When the signal changes,
	 * computes a new class list (appending Array/Set values or applying Object/Map keys) and
	 * renders it via RAF batched DOM update.
	 * 
	 * @private
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $class attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string|null} [value] Expression value
	 * @param {Array<Function>} onReadyQueue Queue for deferred callbacks
	 */
	#attrClass(element,attrib,elementScopeCtrl,options,value,onReadyQueue){
		let instance = this.instance;
		let { attribute:$attribute } = attrib;
		let defaultClasses = element.getAttribute('class') ?? '';
		element[this.#attrClassDefaultSymbol] = defaultClasses;
		element[this.#attrClassAbortSymbol] = { __proto__:null, abort:false };
		let { runFn } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute, $original:defaultClasses },{ __proto__:null, run:false, useReturn:true });
		let obs = instance.scopeCtrl.signalCtrl.createObserver();
		runFn = obs.wrapRecorder(runFn);
		let computeFn = this.#attrClass_compute.bind(this,element,obs,runFn,defaultClasses);
		let renderFn = this.#attrClass_render.bind(this,element);
		let updateFn = timing.queueComputeThenRender.bind(null,computeFn,renderFn);
		onReadyQueue.push(updateFn);
		obs.addListener(updateFn);
		instance.registerElementRelatedEvent(element,obs.clear.bind(obs));
		let removeListener = elementScopeCtrl.ctrl.$on('$update',updateFn,{},true);
		instance.registerElementRelatedEvent(element,removeListener);
	}
	
	#attrClassDefaultSymbol = Symbol('$attrClassDefault');
	#attrClassAbortSymbol = Symbol('$attrClassAbortSymbol');
	
	/**
	 * Undo $class attribute changes on element disconnect.
	 * 
	 * Restores the element's original `class` attribute from the default value stored during
	 * #attrClass setup. If the default was empty, removes the `class` attribute entirely.
	 * Sets the abort flag so no further renders occur after restore.
	 * 
	 * @private
	 * @param {HTMLElement} element The element being disconnected
	 * @param {scopeElementAttribDefaults} attrib The $class attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 */
	#attrClassUndo(element,attrib,elementScopeCtrl,options){
		if(!(this.#attrClassDefaultSymbol in element)) return;
		let value = element[this.#attrClassDefaultSymbol];
		if((value??'')==='') element.removeAttribute('class');
		else element.setAttribute('class',element.className=value);
		delete element[this.#attrClassDefaultSymbol];
		element[this.#attrClassAbortSymbol].abort = true;
	}
	
	/**
	 * Compute the new class list string from the $class expression result.
	 * 
	 * Clears signal observations for the current frame, then evaluates the compiled
	 * expression through the observer's recording scope. Handles three result types:
	 *  - string: concatenated with default classes (space-separated)
	 *  - Array / Set: filtered, joined, and appended after default classes
	 *  - Map / Object: toggles classes on/off using keys as class names and values as booleans
	 * Returns the fully resolved class string for rendering.
	 * 
	 * @private
	 * @param {HTMLElement} element The target element
	 * @param {signalObserver} obs The signal observer used for recording signal access
	 * @param {Function} runFn Compiled expression function (wrapped by obs.wrapRecorder)
	 * @param {string} defaultClasses Original `class` attribute value at connect time
	 * @returns {string|undefined} The computed class string, or undefined if the abort flag is set
	 */
	#attrClass_compute(element,obs,runFn,defaultClasses){
		if(element[this.#attrClassAbortSymbol].abort) return;
		obs.clearSignals();
		let result = runFn();
		if(typeof result==='string') return defaultClasses.length>0 ? defaultClasses+' '+result : result;
		// If array, simply append it after default classes
		else if(result instanceof Array || result instanceof Set){
			let classList = Array.from(result).filter(this.#attrClass_filterArray);
			return defaultClasses.length>0 ? defaultClasses+' '+classList.join(' ') : classList.join(' ');
		}
		// If object, disable any existing classes if needed, and add new classes
		else if(result===Object(result)){
			let classObjEntries, newClassList = new Set(defaultClasses.split(' '));
			if(result instanceof Map) classObjEntries = Array.from(result.entries());
			else classObjEntries = Object.entries(result);
			classObjEntries = classObjEntries.filter(this.#attrClass_filterEntries);
			for(let [k,v] of classObjEntries){
				if(!v && newClassList.has(k)) newClassList.delete(k);
				else if(v) newClassList.add(k);
			}
			return Array.from(newClassList).join(' ');
		}
	}
	
	/**
	 * Render the computed class list onto the element.
	 *
	 * Applies the new className string via `element.className`. A no-op if the abort flag
	 * is set (element disconnected mid-render) or if no class string is provided.
	 * 
	 * @private
	 * @param {HTMLElement} element The target element
	 * @param {string} newClassName The computed class string to apply
	 */
	#attrClass_render(element,newClassName){
		if(element[this.#attrClassAbortSymbol].abort) return;
		if(typeof newClassName==='string') element.className = newClassName;
	}
	
	#attrClass_filterArray(k){ return typeof k==='string' && k.length>0; }
	#attrClass_filterEntries([k,v]){ return typeof k==='string' && k.length>0; }
	
	/**
	 * $signal-name:watch or $signal-name:compute attribute handler.
	 * 
	 * For watch mode: creates a signalObserver that re-runs the watch expression when the signal changes.
	 * For compute mode: creates a computed signal that updates the named signal from a source expression.
	 * 
	 * @private
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $signal attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string} name2 The signal name (eg, 'obj.prop')
	 * @param {string|null} [value] Expression value
	 */
	#attrSignal(element,attrib,elementScopeCtrl,options,name2,value){
		let instance = this.instance, signalCtrl = instance.scopeCtrl.signalCtrl;
		let { attribute:$attribute } = attrib, watchOpt = options.get('watch'), computeOpt = options.get('compute');
		// Watch Signal
		let watchValue = watchOpt?.value?.length>0 ? watchOpt.value : value;
		if(watchValue?.length>0 && !watchOpt.isDefault && (!computeOpt || computeOpt?.value!==watchValue)){
			let { signal, expFn } = instance.ensureExpressionSignal(element,name2);
			if(signal){
				let obs = signalCtrl.createObserver(); obs.recordSignal(signal);
				let state = { __proto__:null, value:void 0, signal };
				let extra = { __proto__:null, $attribute, get $value(){ return signal?.get(); }, get $oldValue(){ return state.value; } };
				let { runFn:watchFn } = instance.elementExecExp(elementScopeCtrl,watchValue,extra,{ __proto__:null, run:false });
				obs.addListener(this.#attrSignal_watchListener.bind(this,state,watchFn));
				instance.registerElementRelatedEvent(element,obs.clear.bind(obs));
			}
		}
		// Compute Signal
		if(computeOpt?.value?.length>0 && !computeOpt.isDefault){
			let { signal } = instance.ensureExpressionSignal(element,name2);
			if(signal){
				let { runFn:computeFn } = instance.elementExecExp(elementScopeCtrl,computeOpt.value,{ __proto__:null, $attribute },{ __proto__:null, run:false, useReturn:true });
				let [ _, obs, clear ] = signalCtrl.computeSignal(function attribSignalCompute(){ return resolveSignal(computeFn()); },{ pull:true, signal });
				instance.registerElementRelatedEvent(element,clear);
			}
		}
	}
	
	#attrSignal_watchListener(state,watchFn,o,s,oVal,nVal){
		state.value = state.signal?.getSilent();
		watchFn();
	}
	
	/**
	 * $on-target-event or $once-target-event attribute handler.
	 * 
	 * Routes to the appropriate event method based on type (on/once) and target (dom/scope/window/document).
	 * The expression is compiled and executed with timing defer based on :raf/:instant options.
	 * The :pd option prevents default behavior.
	 * 
	 * @private
	 * @param {HTMLElement} element The element
	 * @param {scopeElementAttribDefaults} attrib The $on-* attribute definition
	 * @param {scopeElementController} elementScopeCtrl The scope element controller
	 * @param {Map<string,scopeElementAttribOptionDefaults>} options Parsed attribute options
	 * @param {string} type 'on' or 'once'
	 * @param {string} target Event target ('dom', 'scope', 'window', 'document')
	 * @param {string} eventName Event name (eg, 'click', 'keypress')
	 * @param {string|null} [value] Expression value
	 */
	#attrEvent(element,attrib,elementScopeCtrl,options,type,target,eventName,value){
		let instance = this.instance;
		let evtBase=null, evtMethod=null, evtTarget=null;
		if(type==='on' && target==='dom'){ evtBase = elementScopeCtrl; evtMethod = '$onDom'; }
		else if(type==='once' && target==='dom'){ evtBase = elementScopeCtrl; evtMethod = '$onceDom'; }
		else if(type==='on' && target==='scope'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$on'; }
		else if(type==='once' && target==='scope'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$once'; }
		else if(type==='on' && target==='window'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onTarget'; evtTarget=window; }
		else if(type==='once' && target==='window'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onceTarget'; evtTarget=window; }
		else if(type==='on' && target==='document'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onTarget'; evtTarget=document; }
		else if(type==='once' && target==='document'){ evtBase = elementScopeCtrl.ctrl; evtMethod = '$onceTarget'; evtTarget=document; }
		if(evtBase && evtMethod){
			if(value===null) value = instance.elementAttribFallbackOptionValue(attrib,['raf','instant','pd']);
			let { attribute:$attribute } = attrib;
			let raf = options.get('raf'), instant = options.get('instant'), pd = options.get('pd');
			if(value?.length>0){
				let { runFn:eventCB, firstScope } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute },{ __proto__:null, run:false });
				let eventListener = this.#attrEvent_listener.bind(this,element,raf,instant,pd,firstScope,eventCB,$attribute);
				// Register events straight away
				let removeListener = evtTarget ? evtBase[evtMethod](evtTarget,eventName,eventListener,{},true) : evtBase[evtMethod](eventName,eventListener,{},true);
				instance.registerElementRelatedEvent(element,removeListener);
			}
		}
	}
	
	/**
	 * Event listener callback for $on-* / $once-* attribute handlers.
	 *
	 * Applies prevent-default if configured, injects the event into firstScope, then routes
	 * execution through timing.deferTask, timing.onceAnimation (RAF), or immediate execution
	 * based on configuration flags (raf, instant, pd).
	 * 
	 * @private
	 * @param {HTMLElement} element The source element
	 * @param {boolean} raf Whether to defer execution via requestAnimationFrame
	 * @param {boolean} instant Whether to execute immediately without defer
	 * @param {boolean} pd Whether to prevent the default event behavior
	 * @param {object} firstScope The first scope for $event injection
	 * @param {Function} eventCB The expression callback to execute
	 * @param {string} $attribute The attribute key string used for RAF dedup
	 * @param {Event} event The DOM event object
	 * @returns {boolean|void} False if preventDefault was applied, otherwise void
	 */
	#attrEvent_listener(element,raf,instant,pd,firstScope,eventCB,$attribute,event){
		if(pd) event.preventDefault();
		firstScope.$event = event;
		if(timing.isDuringRAF || this.instance.isDuringOnReady) eventCB();
		else if(raf) timing.onceAnimation(element,$attribute,eventCB);
		else if(instant) eventCB();
		else timing.deferTask(eventCB);
		if(pd) return false;
	}
	
}
