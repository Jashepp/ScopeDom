
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
 * ScopeDom built-in attributes.
 * 
 * Handles onConnect & onDisconnect lifecycle for built-in attributes.
 * Called by ScopeDom.triggerElementConnect & ScopeDom.triggerElementDisconnect.
 * 
 * @class builtinAttributes
 */
export class builtinAttributes {
	
	/** @type {ScopeDom} ScopeDom instance */
	constructor(instance){
		this.instance = instance;
	}
	
	/**
	 * Handle element onConnect for built-in attributes.
	 * 
	 * @param {HTMLElement} element The element being connected
	 * @param {Map<string,scopeElementAttribDefaults>} attribs The parsed attributes
	 * @param {scopeElementController} elementScopeCtrl The scope controller for the element
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
	
	#processOnConnectOnReadyQueue(queue){
		for(let cb of queue) cb.apply(this);
	}
	
	/**
	 * Handle element onDisconnect for built-in attributes.
	 * 
	 * @param {HTMLElement} element The element being disconnected
	 * @param {Map<string,scopeElementAttribDefaults>} attribs The parsed attributes
	 * @param {scopeElementController} elementScopeCtrl The scope controller for the element
	 */
	onDisconnect(element,attribs,elementScopeCtrl){
		let instance = this.instance;
		for(let [nameParts,attrib] of attribs){
			let [ name ] = nameParts;
			if(name==='default') continue;
			// Handle deinit / disconnect attributes
			if(nameParts.length===1 && (name==='deinit' || name==='disconnect')){
				let options = this.elementAttribOptionsWithDefaults(element,attrib);
				this.#attrDisconnect(element,attrib,elementScopeCtrl,options);
			}
		}
	}
	
	/**
	 * <template $swap> content \</template>
	 * 
	 * The template element will be swapped/replaced with the template contents when the template has finished loading.
	 * 
	 * A value can be specified $swap="div" to swap the template with an element, with the contents as it's children.
	 * 
	 * No other built-in attributes or plugin attributes will be processed on the template element.
	 * If a value is specified, all other attributes will be moved onto the new element.
	 */
	#attrSwap(element,attribs){
		let anchor = document.createComment(` Template-Swap-Anchor ${this.instance.dev?element.cloneNode(false).outerHTML:''} `);
		element.parentNode.replaceChild(anchor,element);
		this.instance.onElementLoaded(anchor,this.#attrSwap_onElementLoaded.bind(this,element,attribs,anchor));
	}
	
	#attrSwap_onElementLoaded(element,attribs,anchor){
		let swap = attribs.get('swap'), fragment=element.content, dom=fragment;
		element.removeAttribute(swap.attribute);
		if(swap?.value?.length>0){
			dom = document.createElement(swap.value);
			for(let a of element.attributes) dom.attributes.setNamedItem(a.cloneNode(false));
			dom.appendChild(fragment);
		}
		anchor.parentNode.replaceChild(dom,anchor);
	}
	
	/**
	 * $scope="{ localVariable:123 }" or $scope-name="namedController"
	 * 
	 * Creates a new scope for the element. The element & all children will access this scope before parent scopes.
	 * 
	 * A scope can be isolated from its parents, via the $scope:isolate option. The parent scopes are then only accessible via $scopeParent and $scopeTop.
	 * 
	 * The scope expression is executed while in the parent scope context, so specific variables can be passed through.
	 * 
	 * $scopeElement is available in the scope, which is the element that the scope is attached to.
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
	 * $connect="exp" or $init="exp"
	 * 
	 * Runs the expression when the element is connected to the DOM.
	 * 
	 * The expression execution is deferred. :raf option executes it on next animation frame. :instant option executes it immediately.
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
	
	#attrConnect_onReady(element,$attribute,raf,instant,connectCB){
		if(raf && !timing.isDuringRAF) timing.onceAnimation(element,$attribute,connectCB);
		else if(instant) connectCB();
		else timing.deferTask(connectCB);
	}
	
	/**
	 * $disconnect="exp" or $deinit="exp"
	 * 
	 * Runs the expression when the element is disconnected from the DOM.
	 * 
	 * The expression execution is deferred. :raf option executes it on next animation frame. :instant option executes it immediately.
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
	 * $update="exp" or $update-name="exp"
	 * 
	 * Runs the expression when ScopeDom updates occur (when $update() is called).
	 * 
	 * If a 'name' is specified, such as $update-customword, then it will only be executed when $update('customword') is called.
	 * 
	 * Executing before or after can be done with $update:before="exp" or $update:after="exp"
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
	 * $class="[ 'list','of','classes' ]" or $class="{ class1:true, class2:false }"
	 * 
	 * The element's class list is appended/updated based on the expression result.
	 * 
	 * If the expression is an Array/Set, they will be appended to the existing class list.
	 * 
	 * If the expression is an Object/Map, keys are class names, values determine if the class should be present (true=keep/add, false=remove).
	 */
	#attrClass(element,attrib,elementScopeCtrl,options,value,onReadyQueue){
		let instance = this.instance;
		let { attribute:$attribute } = attrib;
		let obs = instance.scopeCtrl.signalCtrl.createObserver();
		let defaultClasses = element.getAttribute('class') ?? '';
		let { runFn } = instance.elementExecExp(elementScopeCtrl,value,{ __proto__:null, $attribute, $original:defaultClasses },{ __proto__:null, run:false, useReturn:true });
		runFn = obs.wrapRecorder(runFn);
		let computeFn = this.#attrClass_compute.bind(this,obs,runFn,defaultClasses);
		let renderFn = this.#attrClass_render.bind(this,element);
		let updateFn = timing.queueComputeThenRender.bind(null,computeFn,renderFn);
		onReadyQueue.push(updateFn);
		obs.addListener(updateFn);
		instance.registerElementRelatedEvent(element,obs.clear.bind(obs));
		let removeListener = elementScopeCtrl.ctrl.$on('$update',updateFn,{},true);
		instance.registerElementRelatedEvent(element,removeListener);
	}
	
	#attrClass_compute(obs,runFn,defaultClasses){
		obs.clearSignals();
		let result = runFn();
		// If array, simply append it after default classes
		if(result instanceof Array || result instanceof Set){
			let classList = Array.from(result).filter(this.#attrClass_filterArray);
			return defaultClasses+' '+classList.join(' ');
		}
		// If object or map, disable any existing classes if needed, and add new classes
		else if(result instanceof Map || result===Object(result)){
			let newClassList = new Set(defaultClasses.split(' '));
			let classObj = Object.entries(result).filter(this.#attrClass_filterEntries);
			for(let [k,v] of classObj){
				if(!v && newClassList.has(k)) newClassList.delete(k);
				else if(v) newClassList.add(k);
			}
			return Array.from(newClassList).join(' ');
		}
	}
	
	#attrClass_render(element,newClassName){
		if(newClassName!==void 0) element.className = newClassName;
	}
	
	#attrClass_filterArray(k){ return typeof k==='string' && k.length>0; }
	#attrClass_filterEntries([k,v]){ return typeof k==='string' && k.length>0; }
	
	/**
	 * $signal-name:watch="exp" or $signal-name:compute="exp"
	 * 
	 * Creates reactive bindings to signals, with the `name` being the resolvable signal to use (eg, $signal-obj.prop).
	 * 
	 * The `watch` option runs an expression when the signal changes.
	 * The `compute` option computes and updates the signal value from another expression.
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
				let oldValue, extra = { __proto__:null, $attribute, get $value(){ return signal?.get(); }, get $oldValue(){ return oldValue; } };
				let { runFn:watchFn } = instance.elementExecExp(elementScopeCtrl,watchValue,extra,{ __proto__:null, run:false });
				watchFn = obs.wrapRecorder(watchFn);
				obs.addListener(function attribSignalWatchValue(obs,s,o){ oldValue=o; watchFn(); });
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
	
	/**
	 * $on-click="exp" or $on-scope-customevt="exp" or $on-window-keypress="exp"
	 * 
	 * Registers event listeners on DOM elements ($on- or $on-dom-), scope controller ($on-scope-), window ($on-window-) or document ($on-document-).
	 * 
	 * The `raf` option defers execution to next animation frame.
	 * The `instant` option executes the expression immediately.
	 * The `pd` option prevents default behavior.
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
