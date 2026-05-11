
import {
	noopFn,noopAsyncFn,setUnion,disposeSymbol,isPromise,
	microtaskCache,mtCacheGetDefinedProperty,mtCacheDefineProperty,mtCacheGetPrototypeOf,mtCacheSetPrototypeOf,
	regexMatchAll,regexExec,regexTest,regexMatchAllFirstGroup,
	elementNodeType,commentNodeType,textNodeType,
	getPrototypeOf,getOwnPropertyDescriptor,defineProperty,hasOwn,
	objectProto,nodeProto,elementProto,functionProto,functionAsyncProto,nativeProtos,nativeConstructors,
	isNative,scopeAllowed,defineWeakRef,
	setAttribute,eventRegistry,
} from "../utils.js";
import {
	timing,
} from "../timing.js";
import {
	execExpression,execExpressionProxy,
} from "../exec.js";
import {
	signalController, signalObserver, signalProxy, signalInstance, resolveSignal, signalSymb,
} from "../signal.js";
import {
	scopeElementContext, scopeElementController
} from "./element.js";
import ScopeDom from "../../scopedom.js";


/**
 * Wrapper/mixin class for scope instances.
 * 
 * Provides $scopeTop and $scopeParent getters for scope hierarchy access.
 * This class handles the prototype switching logic: if scopeObj is a plain Object,
 * its prototype is changed to scopeBase; otherwise, this instance inherits from scopeObj.
 * 
 * @class scopeInstance
 */
export class scopeInstance {
	
	/**
	 * @constructor
	 * @param {object} scopeObj Base scope object
	 * @param {scopeController} scopeCtrl Parent scopeController
	 * @returns Either scopeInstance or an object with a changed prototype
	 */
	constructor(scopeObj,scopeCtrl){
		let mainObj = this;
		// If scopeObj has object prototype, change it
		if(mtCacheGetPrototypeOf(scopeObj)===objectProto){
			mtCacheSetPrototypeOf(scopeObj,new scopeBase());
			mainObj = scopeObj;
		}
		// Otherwise, change prototype to scopeObj, making this instance inherit
		else mtCacheSetPrototypeOf(this,scopeObj);
		// Add methods
		Object.defineProperties(mainObj,{
			$scopeTop:{ __proto__:null, configurable:false, enumerable:false, get:scopeInstance.#descScopeTopGetter.bind(null,scopeCtrl) },
			$scopeParent:{ __proto__:null, configurable:false, enumerable:false, get:scopeInstance.#descScopeParentGetter.bind(null,scopeCtrl) },
		});
		// Return this, or scopeObj if proto changed
		return mainObj;
	}
	
	static #descScopeTopGetter(scopeCtrl){
		return scopeCtrl?.topCtrl?.scope || scopeCtrl?.parentCtrl?.topCtrl?.scope || scopeCtrl?.parentCtrl?.scope || scopeCtrl?.scope;
	}
	
	static #descScopeParentGetter(scopeCtrl){
		return scopeCtrl?.parentCtrl?.scope || scopeCtrl?.scope;
	}
	
};

/**
 * Base class for scope objects.
 * 
 * Creates an object with null prototype and $scope self-reference getter.
 * 
 * @class scopeBase
 */
export class scopeBase {
	/**
	 * Creates an object with null prototype and a $scope self-reference getter that returns `this`.
	 * 
	 * @constructor
	 * @returns {object} A new scope base object
	 */
	constructor(){ return Object.create(null,{
		__proto__: { __proto__:null, value:null },
		$scope:{ __proto__:null, configurable:false, enumerable:false, get:scopeBase.#descThisGetter }
	}); }
	
	static #descThisGetter(){ return this; }
	
}

const scSymb = Symbol('$scopeControllerContext');

/**
 * Expression context class for scope controller operations.
 * 
 * Provides access to scope controller methods and properties in expressions.
 * 
 * @class scopeControllerContext
 */
export class scopeControllerContext {
	/**
	 * @constructor
	 * @param {scopeController} scopeCtrl - The scopeController instance
	 */
	constructor(scopeCtrl){ this[scSymb]=scopeCtrl; }
	
	/**
	 * Get the scopeInstance associated with this context.
	 * 
	 * @type {scopeInstance}
	 */
	get $scope(){ return this[scSymb].scope; };
	
	/**
	 * Emit scope update event on the scope event registry.
	 * 
	 * If no suffix, then this is used to update all expressions, needed if signals/reactivity aren't enabled.
	 * Plugins listen for this as well as signals.
	 * 
	 * @param {string} [suffix=''] Optional suffix for custom update events
	 * @returns {boolean} Result of the event dispatch
	 */
	$update(suffix=''){ return this[scSymb].$emitScopeUpdate(suffix); };
	
	/**
	 * Remove an event listener from scope event registry.
	 * 
	 * If no arguments, all registered events will be removed from the scope event registry.
	 * 
	 * @param {string} [name=null] Event name to remove (all if null)
	 * @param {Function} [listener=null] Event listener function to remove (if null, all with same name)
	 * @param {object} [options=null] Event options to match (if null, all with same name & listener)
	 * @returns {boolean} Result of removal
	 */
	$off(name=null,listener=null,options=null){ return this[scSymb].$off(name,listener,options); };
	
	/**
	 * Add an event listener to scope event registry.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options={}] Event options (capture:true, passive:false)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$on(name,listener,options={},returnRemove=false){ return this[scSymb].$on(name,listener,options,returnRemove); };
	
	/**
	 * Add a one-time event listener to scope event registry.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options={}] Event options (capture:true, passive:false, once:true)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$once(name,listener,options={},returnRemove=false){ return this[scSymb].$once(name,listener,options,returnRemove); };
	
	/**
	 * Emit a custom event on the scope event registry.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options (detail, bubbles:false, cancelable:false, composed:true)
	 * @returns {boolean} Result of dispatch
	 */
	$emit(name,detail=null,options=null){ return this[scSymb].$emit(name,detail,options); };
	
	/**
	 * Emit a custom event on RAF (request animation frame) for the scope.
	 * 
	 * Deduplicates events by uniqueID to prevent multiple rapid emissions.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options
	 * @param {string} [uniqueID] Unique ID for onceRAF deduplication
	 * @returns {void}
	 */
	$emitRAF(name,detail=null,options=null,uniqueID=this.$attribute||'$emitRAF:scc'){
		let scopeCtrl = this[scSymb];
		return timing.onceAnimation(this.$this||scopeCtrl.scope,uniqueID+':'+name,scopeCtrl.$emit.bind(scopeCtrl,name,detail,options));
	};
	
	/**
	 * Request an animation frame callback.
	 * 
	 * @param {Function} cb Callback function to execute on next animation frame
	 */
	$onRAF(cb){ return timing.requestAnimation(cb); };
	
	/**
	 * Add a one-time animation frame callback.
	 * 
	 * Deduplicates callbacks by uniqueID to prevent multiple executions.
	 * 
	 * @param {Function} cb Callback function to execute on next animation frame
	 * @param {string} [uniqueID] Unique ID for onceRAF deduplication
	 */
	$onceRAF(cb,uniqueID=this.$attribute||'$onceRAF:scc'){ return timing.onceAnimation(this.$this||this[scSymb].scope,uniqueID,cb); };
	
	/**
	 * Remove an event listener from an element/EventTarget.
	 * 
	 * If no name, listener & options, all registered events will be removed from the element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} [name=null] Event name to remove (all if null)
	 * @param {Function} [listener=null] Event listener function to remove (if null, all with same name)
	 * @param {object} [options=null] Event options to match (if null, all with same name & listener)
	 * @returns {boolean} Result of removal
	 */
	$offTarget(target,name=null,listener=null,options=null){ return this[scSymb].$offTarget(target,name,listener,options); };
	
	/**
	 * Add an event listener to an element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options={}] Event options (capture:true, passive:false)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onTarget(target,name,listener,options={},returnRemove=false){ return this[scSymb].$onTarget(target,name,listener,options,returnRemove); };
	
	/**
	 * Add a one-time event listener to an element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options={}] Event options (capture:true, passive:false, once:true)
	 * @param {boolean} [returnRemove=false] Return remove function
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onceTarget(target,name,listener,options={},returnRemove=false){ return this[scSymb].$onceTarget(target,name,listener,options,returnRemove); };
	
	/**
	 * Emit a custom event on an element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options (detail, bubbles:false, cancelable:false, composed:true)
	 * @returns {boolean} Result of dispatch
	 */
	$emitTarget(target,name,detail=null,options=null){ return this[scSymb].$emitTarget(target,name,detail,options); };
	
	/**
	 * Create a new signal instance & record it immediately to any recording signal observers.
	 * 
	 * @param {any} [value] Initial signal value
	 * @returns {signalInstance} The created signal instance
	 */
	$signal(value=void 0){ return this[scSymb].$createSignal(value); }
	
}

/**
 * The Main Scope Controller.
 * 
 * This handles scope event registry, other controller references & etc.
 * 
 * @class scopeController
 */
export class scopeController {
	
	/**
	 * @constructor
	 * @param {scopeBase|object|null} [scopeObj=new scopeBase()] Scope base object
	 * @param {EventTarget|null} [eventTarget=null] Event Target
	 * @param {scopeController|scopeElementController|null} [parentCtrl=null] Parent scopeController
	 * @param {boolean} [isolated=false] Use scope isolation mode
	 * @param {ScopeDom|null} [ScopeDomInstance=null] ScopeDom instance
	 */
	constructor(scopeObj=new scopeBase(),eventTarget=null,parentCtrl=null,isolated=false,ScopeDomInstance=null){
		if(scopeObj!==Object(scopeObj)) throw new Error("Missing scope object");
		if(parentCtrl instanceof scopeElementController) parentCtrl = parentCtrl.ctrl;
		this.ScopeDomInstance = ScopeDomInstance || parentCtrl?.ScopeDomInstance || null;
		this.eventRegistry = new eventRegistry();
		this.eventTarget = (eventTarget && eventTarget instanceof EventTarget) ? eventTarget : new EventTarget();
		this.verbose = false;
		this.topCtrl = parentCtrl?.topCtrl || null;
		this.parentCtrl = parentCtrl || null;
		this.isolated = isolated;
		/** @type {scopeInstance} */
		this.scope = new scopeInstance(scopeObj,this);
		/** @type {scopeControllerContext} */
		this.execContext = new scopeControllerContext(this);
		this.isDuringUpdate = false;
		/** @type {signalController} */
		this.signalCtrl = this.ScopeDomInstance?.scopeCtrl?.signalCtrl || parentCtrl?.signalCtrl || new signalController(this);
	}
	
	/**
	 * Emit scope update event on the scope event registry.
	 * 
	 * If no suffix, then this is used to update all expressions, needed if signals/reactivity aren't enabled.
	 * Plugins listen for this as well as signals.
	 * 
	 * @param {string} [suffix] Optional suffix for custom update events (not used by any core features)
	 */
	$emitScopeUpdate(suffix=''){
		let evt = '$update'+(suffix?.length>0?'-'+suffix:'');
		let emitUpdate = this.#emitUpdate.bind(this,evt);
		if(timing.isDuringRAF || this.ScopeDomInstance.isDuringOnReady || this.isDuringUpdate) timing.deferTask(emitUpdate);
		else timing.onceAnimation(this.scope,evt,emitUpdate,true);
	}
	
	#emitUpdate(evt){
		if(this.isDuringUpdate) return;
		this.isDuringUpdate = true;
		this.$emit(evt+':before'); this.$emit(evt); this.$emit(evt+':after');
		this.isDuringUpdate = false;
	}
	
	/**
	 * Remove an event listener from scope event registry.
	 * 
	 * If no arguments, all registered events will be removed from the scope event registry.
	 * 
	 * @param {string} [name=null] Event name
	 * @param {Function} [listener=null] Event listener function
	 * @param {object} [options=null] Event options
	 * @returns {boolean} Result of removal
	 */
	$removeEvent(name=null,listener=null,options=null){
		return this.eventRegistry.remove(this.eventTarget,name,listener,options);
	}
	
	/**
	 * Remove an event listener from scope event registry.
	 * 
	 * If no arguments, all registered events will be removed from the scope event registry.
	 * Alias of $removeEvent.
	 * 
	 * @param {string} [name=null] Event name
	 * @param {Function} [listener=null] Event listener function
	 * @param {object} [options=null] Event options
	 * @returns {boolean} Result of removal
	 */
	$off(name=null,listener=null,options=null){
		return this.$removeEvent(name,listener,options);
	}
	
	/**
	 * Add an event listener to scope event registry.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture:true, passive:false)
	 * @param {boolean} [returnRemove=false] Return remove function (recommended)
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$on(name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, ...options };
		this.eventRegistry.add(this.eventTarget,name,listener,options);
		if(returnRemove) return this.eventRegistry.remove.bind(this.eventRegistry,this.eventTarget,name,listener,options);
	}
	
	/**
	 * Add a one-time event listener to scope event registry.
	 * 
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture:true, passive:false, once:true)
	 * @param {boolean} [returnRemove=false] Return remove function (recommended)
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$once(name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, once:true, ...options };
		return this.$on(name,listener,options,returnRemove);
	}
	
	/**
	 * Emit a custom event on the scope event registry.
	 * 
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options (detail, bubbles:false, cancelable:false, composed:true)
	 * @returns {boolean} Result of dispatch
	 */
	$emit(name,detail=null,options=null){
		options = { __proto__:null, detail:detail, bubbles:false, cancelable:false, composed:true, ...options };
		return this.eventTarget.dispatchEvent(new CustomEvent(name,options));
	}
	
	/**
	 * Remove an event listener from an element/EventTarget.
	 * 
	 * If no name, listener & options, all registered events will be removed from the element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} [name=null] Event name
	 * @param {Function} [listener=null] Event listener function
	 * @param {object} [options=null] Event options
	 * @returns {boolean} Result of removal
	 */
	$offTarget(target,name=null,listener=null,options=null){
		return this.eventRegistry.remove(target,name,listener,options);
	}
	
	/**
	 * Add an event listener to an element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture:true, passive:false)
	 * @param {boolean} [returnRemove=false] Return remove function (recommended)
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onTarget(target,name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, ...options };
		this.eventRegistry.add(target,name,listener,options);
		let remove = this.eventRegistry.remove.bind(this.eventRegistry,target,name,listener,options);
		if(target instanceof Element) this.ScopeDomInstance.registerElementRelatedEvent(target,remove);
		if(returnRemove) return remove;
	}
	
	/**
	 * Add a one-time event listener to an element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} name Event name
	 * @param {Function} listener Event listener function
	 * @param {object} [options] Event options (capture:true, passive:false, once:true)
	 * @param {boolean} [returnRemove=false] Return remove function (recommended)
	 * @returns {Function|undefined} Remove function if returnRemove is true
	 */
	$onceTarget(target,name,listener,options={},returnRemove=false){
		options = { __proto__:null, capture:true, passive:false, once:true, ...options };
		return this.$onTarget(target,name,listener,options,returnRemove);
	}
	
	/**
	 * Emit a custom event on an element/EventTarget.
	 * 
	 * @param {EventTarget} target Target element/EventTarget
	 * @param {string} name Event name
	 * @param {object} [detail=null] Event detail
	 * @param {object} [options=null] Event options (detail, bubbles:false, cancelable:false, composed:true)
	 * @returns {boolean} Result of dispatch
	 */
	$emitTarget(target,name,detail=null,options=null){
		options = { __proto__:null, detail:detail, bubbles:false, cancelable:false, composed:true, ...options };
		return target.dispatchEvent(new CustomEvent(name,options));
	}
	
	/**
	 * Create a new signalInstance and records it to any recording observers.
	 * 
	 * This is similar to $createSignal, except it returns an array with [ getter, setter, signalInstance ].
	 * 
	 * @param {any} [value] Initial signal value
	 * @param {boolean} [useWeakRef=false] Use weak references
	 * @returns {Array<Function,Function,signalInstance>} [ getter, setter, signalInstance ]
	 */
	$signal(value=void 0,useWeakRef=false){ return this.signalCtrl.signal(value,useWeakRef); }
	
	/**
	 * Create a new signal instance & record it immediately to any recording signal observers.
	 * 
	 * This only returns the signalInstance.
	 * 
	 * @param {any} [value] Initial signal value
	 * @param {boolean} [useWeakRef=false] Use weak references
	 * @returns {signalInstance} The created signal instance
	 */
	$createSignal(value=void 0,useWeakRef=false){ return this.signalCtrl.createSignal(value,useWeakRef); }
	
	/**
	 * Define a signal on an object property (getter & setter).
	 * 
	 * @param {object} obj Object to define signal on
	 * @param {string} prop Property name
	 * @param {any} [value] Initial signal value
	 * @param {PropertyDescriptor|null} [descriptor=null] Property descriptor
	 * @param {boolean} [useOriginal=true] Use original descriptor (if existing getter or setter exists)
	 * @returns {signalInstance} The created signal instance
	 */
	$defineSignal(obj,prop,value=void 0,descriptor=null,useOriginal=true){ return this.signalCtrl.defineSignal(obj,prop,value,descriptor,useOriginal); }
	
	/**
	 * Assign signals from source to target object (getters & setters).
	 * 
	 * @param {object} target Target object to assign signals to
	 * @param {object} source Source object to assign signals from
	 * @returns {object} The target object with assigned signals
	 */
	$assignSignals(target,source){ return this.signalCtrl.assignSignals(target,source); }
	
	/**
	 * Compute a signal from a function, which may use other signals within it.
	 * 
	 * This returns an array with [ signal, observer, clear function ].
	 * Call this clear() function during cleanup, otherwise the signalObserver will stick around.
	 * 
	 * @param {Function} fn Function to compute signal from
	 * @param {object} [options] { pull:true } Options
	 * @returns {[signalInstance,signalObserver,Function]} [ signal, observer, clear function ]
	 */
	$computeSignal(fn,options={}){ return this.signalCtrl.computeSignal(fn,options); }
	
	/**
	 * Create a signal proxy for an object.
	 * 
	 * All properties will be treated signals.
	 * 
	 * @param {any} value Object to proxy
	 * @returns {Proxy} The created proxy
	 */
	$proxySignal(value){ return this.signalCtrl.proxySignal(value); }
	
	/**
	 * Define a signal proxy on an object property.
	 * 
	 * @param {object} obj Object to define proxy signal on
	 * @param {string} prop Property name
	 * @param {any} value Object to proxy
	 * @returns {Proxy} The created proxy
	 */
	$defineProxySignal(obj,prop,value){ return this.signalCtrl.defineProxySignal(obj,prop,value); }
	
	/**
	 * Prevent signal updates during function execution.
	 * 
	 * This prevents all updates from signal changes during execution.
	 * If this behaviour doesn't match what you need, try preventObservers or isolateRecording & wrapRecorder.
	 * 
	 * @param {Function} fn Function to execute.
	 * @param {...*} [args] Additional arguments to pass to the function
	 * @returns {any} Result of executed function
	 */
	$preventSignalUpdates(fn,...args){ return this.signalCtrl.preventUpdates(fn,...args); }
	
	/**
	 * Prevent signal observers during function execution.
	 * 
	 * This prevents the recording of any signals during execution.
	 * If this behaviour doesn't match what you need, try preventUpdates or isolateRecording & wrapRecorder.
	 * 
	 * @param {Function} fn Value to prevent observers for
	 * @param {...*} [args] Additional arguments to pass to the function
	 * @returns {any} Result of executed function
	 */
	$preventSignalObservers(fn,...args){ return this.signalCtrl.preventObservers(fn,...args); }
	
}
