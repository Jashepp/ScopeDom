
import {
	noopFn, noopAsyncFn, setUnion, disposeSymbol, isPromise,
	microtaskCache, mtCacheGetDefinedProperty, mtCacheDefineProperty, mtCacheGetPrototypeOf, mtCacheSetPrototypeOf,
	regexMatchAll, regexExec, regexTest, regexMatchAllFirstGroup,
	elementNodeType, commentNodeType, textNodeType,
	getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn,
	objectProto, nodeProto, elementProto, functionProto, functionAsyncProto, nativeProtos, nativeConstructors,
	isNative, scopeAllowed, defineWeakRef,
	setAttribute, eventRegistry,
} from "../utils.js";
import {
	timing,
} from "../timing.js";
import {
	execExpression, execExpressionProxy,
} from "../exec.js";
import {
	scopeInstance, scopeBase, scopeControllerContext, scopeController, scopeElementContext, scopeElementController,
} from "../scope.js";

import { signalObserver } from "./observer.js";
import { signalInstance, signalSymb } from "./instance.js";
import { signalProxy, resolveSignal } from "./proxy.js";

/**
 * Signal Controller for managing signals and observers.
 * 
 * The signal controller is the central orchestrator of the reactive signal system.
 * 
 * This class provides methods to:
 * - Create and manage {@link signalInstance} objects (basic reactive values)
 * - Create and manage {@link signalObserver} objects (dependency trackers)
 * - Define signals on object properties via getters/setters
 * - Create computed signals (both PUSH-based for automatic updates and PULL-based for lazy evaluation)
 * - Create deep reactive proxies that enable infinitely nested reactivity
 * 
 * @class signalController
 * @property {scopeController} scopeCtrl - The parent scope controller
 * 
 * @see {@link signalController} - Signal Controller for managing signals and observers
 * @see {@link signalObserver} - Signal Observer for tracking signal dependencies
 * @see {@link signalInstance} - Signal Instance that represents a reactive signal value
 * @see {@link signalProxy} - Signal Proxy for deep reactivity for objects with automatic signal tracking
 */
export class signalController {
	
	/** @type {boolean} Internal flag to prevent observer update triggers during sensitive operations */
	#preventUpdates = false;
	
	/** @type {boolean} Internal flag to prevent observers from recording signals during sensitive operations */
	#preventObservers = false;
	
	/** @type {Set<object>} Set of observers currently in recording mode (tracking their accessed signals as dependencies) */
	#observersRecording = new Set();
	
	/** @type {Set<object>} Set of all registered observers managed by this controller */
	#observers = new Set();
	
	/**
	 * Constructs a new signalController with a reference to the parent scope controller.
	 * 
	 * If a scopeElementController is provided, it extracts the underlying signalController.
	 * 
	 * @constructor
	 * @param {scopeController|scopeElementController} scopeCtrl - The parent scope controller
	 */
	constructor(scopeCtrl){
		if(scopeCtrl instanceof scopeElementController) scopeCtrl = scopeCtrl.ctrl;
		this.scopeCtrl = scopeCtrl;
	}
	
	/**
	 * Creates a new signalObserver instance.
	 * 
	 * Observers track which signals they depend on and can react to changes. 
	 * When any dependent signal changes, the observer's listeners are invoked via {@link triggerChange}.
	 * Observers are automatically registered with this controller so they receive change notifications.
	 * 
	 * @param {object} options - Observer configuration options (see {@link signalObserver})
	 * @param {boolean} [options.defer=false] - Defer observer listener execution
	 * @returns {signalObserver} The newly created signalObserver instance (also added to this controller's observers set)
	 */
	createObserver(options={}){ let o=new signalObserver(this,options); this.#observers.add(o); return o; }
	
	/**
	 * Removes a signalObserver from the controller.
	 * 
	 * @param {signalObserver} observer - The observer to remove
	 * @param {boolean} [clear=true] - Clear the observer's signals and listeners
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	removeObserver(observer,clear=true){
		if(!(observer instanceof signalObserver)) throw new TypeError("removeObserver observer must be a signalObserver");
		this.#observers.delete(observer); this.#observersRecording.delete(observer);
		if(clear) observer.clear();
	}
	
	/**
	 * Begins recording signals for a specific observer.
	 * 
	 * Signals accessed while an observer is in recording mode are tracked as dependencies.
	 * 
	 * @param {signalObserver} observer - The observer to start recording for
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	startObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("startObserverRecording observer must be a signalObserver");
		this.#observersRecording.add(observer);
	}
	
	/**
	 * Stops recording signals for a specific observer.
	 * 
	 * @param {signalObserver} observer - The observer to stop recording for
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	stopObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("stopObserverRecording observer must be a signalObserver");
		this.#observersRecording.delete(observer);
	}
	
	/**
	 * Triggers a change notification to all observers that have the given signal recorded.
	 * 
	 * When a signal changes value, it calls this method which then notifies all dependent observers via {@link signalObserver.triggerChange}.
	 * Observers may execute immediately or defer based on their configuration.
	 * 
	 * @param {signalInstance} signal - The signal that changed
	 * @param {any} oldValue - The previous value before the change
	 * @param {any} newValue - The new value after the change
	 * @throws {TypeError} If signal is not a signalInstance instance
	 */
	triggerChange(signal,oldValue,newValue){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerChange signal must be a signalInstance");
		if(!this.#preventUpdates) for(let observer of this.#observers) if(observer.hasSignal(signal)) observer.triggerChange(signal,oldValue,newValue);
	}
	
	/**
	 * Triggers the specified signal to be recorded on currently recording observers, as a dependency.
	 * 
	 * @param {signalInstance} signal - The signal to record on observers
	 * @throws {TypeError} If signal is not a signalInstance instance
	 */
	triggerRecording(signal){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerRecording signal must be a signalInstance");
		if(!this.#preventObservers) for(let observer of this.#observersRecording) observer.recordSignal(signal);
	}
	
	/**
	 * This method wraps a function in a context where signal recording is temporarily disabled for existing observers.
	 * Used internally by {@link computeSignalPush} & {@link computeSignalPull}.
	 * 
	 * The returned wrapper captures the current set of recording observers, clears them, executes the function, then restores them.
	 * This prevents nested operations from accidentally recording signals on observers that shouldn't see them during computation.
	 * 
	 * @param {Function} fn - Function to run in isolated recording context
	 * @returns {Function} A wrapped function that captures and restores recording observers (executes in isolated recording mode)
	 * @throws {TypeError} If fn is not a Function
	 */
	isolateRecording(fn){
		if(!(fn instanceof Function)) throw new TypeError("isolateRecording fn must be a Function (callback)");
		return this.#isolatedSignalRecording.bind(this,fn);
	}
	
	#isolatedSignalRecording(fn,...args){
		let prev = Array.from(this.#observersRecording);
		this.#observersRecording.clear();
		let result; try{ result=fn(...args); }catch(err){ console.error(err); }
		for(let observer of prev) this.#observersRecording.add(observer);
		return result;
	}
	
	/**
	 * Prevents signals from triggering updates to observers during function execution.
	 * 
	 * This creates a temporary "quiet zone" where signal changes don't propagate to observers.
	 * Useful when you need to modify signals without triggering cascading updates, such as during initialisation.
	 * 
	 * @param {Function} fn - Function to run without triggering observer updates
	 * @param {...*} args - Arguments to pass to the function
	 * @returns {any} The function's result, or throws any error that occurred
	 * @throws {TypeError} If fn is not a Function
	 */
	preventUpdates(fn,...args){
		if(!(fn instanceof Function)) throw new TypeError("preventUpdates fn must be a Function (callback)");
		let result, error;
		this.#preventUpdates = true;
		try{ result=fn(...args); }catch(err){ error=err; }
		this.#preventUpdates = false;
		if(error) throw error;
		return result;
	}
	
	/**
	 * Prevents observers from recording signals during function execution.
	 * 
	 * This creates a temporary "quiet zone" where recording observers don't record new signal dependencies.
	 * Existing tracked signals will still trigger updates.
	 * 
	 * @param {Function} fn - Function to run without observers recording signals
	 * @param {...*} args - Arguments to pass to the function
	 * @returns {any} The function's result, or throws any error that occurred
	 * @throws {TypeError} If fn is not a Function
	 */
	preventObservers(fn,...args){
		if(!(fn instanceof Function)) throw new TypeError("preventObservers fn must be a Function (callback)");
		let result, error;
		this.#preventObservers = true;
		try{ result=fn(...args); }catch(err){ error=err; }
		this.#preventObservers = false;
		if(error) throw error;
		return result;
	}
	
	// Signal Helper Methods
	
	/**
	 * Creates a new signalInstance and records it to any recording observers.
	 * 
	 * This is similar to createSignal, except it returns an array with [ getter, setter, signalInstance ].
	 * 
	 * @param {any} [value] Initial signal value
	 * @returns {Array<Function,Function,signalInstance>} [ getter, setter, signalInstance ]
	 */
	signal(value=void 0,useWeakRef=false){ let s=this.createSignal(value,useWeakRef); return [s.get.bind(s),s.set.bind(s),s]; }
	
	/**
	 * Creates a new signalInstance and records it to any recording observers.
	 * 
	 * @param {any} value - Initial signal value (cannot be Array, Map, or Set)
	 * @param {boolean} [useWeakRef=false] - Use WeakRef for the value. It must be referenced elsewhere otherwise it may vanish on a GC event
	 * @returns {signalInstance} The created signal instance
	 * @throws {TypeError} If value is an Array, Map, or Set (use proxySignal instead)
	 */
	createSignal(value=void 0,useWeakRef=false){
		if(value instanceof Array) throw new TypeError("createSignal value is an Array, use proxySignal instead");
		if(value instanceof Map) throw new TypeError("createSignal value is a Map, use proxySignal instead");
		if(value instanceof Set) throw new TypeError("createSignal value is a Set, use proxySignal instead");
		let signal = new signalInstance(this,value,useWeakRef); signal.record();
		return signal;
	}
	
	/**
	 * Creates a signalInstance and defines a getter/setter on the target object.
	 * 
	 * @param {object} obj - Target object to define the property on
	 * @param {string} prop - Property name to define
	 * @param {signalInstance|any} [value=void 0] - Initial signal value or existing signal instance
	 * @param {PropertyDescriptor|object} [descriptor={}] - Property descriptor options
	 * @param {boolean} [useOriginal=true] - Use existing getter/setter
	 * @returns {signalInstance} The created or provided signal instance
	 */
	defineSignal(obj,prop,value=void 0,descriptor={},useOriginal=true){
		let { configurable=true, enumerable=true, get:oGet=null, set:oSet=null } = { __proto__:null, ...descriptor };
		let signal = value instanceof signalInstance ? value : this.createSignal(value), sGet, sSet;
		if(useOriginal && oSet){
			if(oGet) sGet = this.#defineSignalGetterWrapper.bind(this,signal,oGet,obj);
			sSet = this.#defineSignalSetterWrapper.bind(this,signal,oGet,obj);
		}
		if(!sGet) sGet = signal.get.bind(signal);
		if(!sSet) sSet = signal.set.bind(signal);
		sGet[signalSymb] = sSet[signalSymb] = signal;
		mtCacheDefineProperty(obj,prop,{ __proto__:null, configurable, enumerable, get:sGet, set:sSet });
		return signal;
	}
	
	#defineSignalGetterWrapper(signal,oGet,obj){
		signal.set(oGet.apply(obj));
		return signal.get();
	}
	
	#defineSignalSetterWrapper(signal,oGet,obj){
		oSet.apply(obj,[v]);
		if(oGet) v = oGet.apply(obj);
		return signal.set(v);
	}
	
	/**
	 * Defines signals for each property from a source object and assigns them to target.
	 * 
	 * @param {object} target - Target object to assign signals to
	 * @param {object} source - Source object to copy properties from
	 * @returns {object} The target object with signals assigned
	 */
	assignSignals(target,source){
		for(let [key,val] of Object.entries(source)) this.defineSignal(target,key,val,getOwnPropertyDescriptor(source,key));
		return target;
	}
	
	/**
	 * Creates a PUSH-based computed signal.
	 * 
	 * PUSH-based computed signals compute their value whenever any of their dependency signals change.
	 * 
	 * @param {Function} fn - Callback function that computes the signal value
	 * @param {object} [options={}] - Compute options
	 * @param {boolean} [options.defer=false] - Defer computation
	 * @param {signalInstance} [options.signal] - Pre-existing signal to use
	 * @returns {Array<[signalInstance, signalObserver, Function]>} Tuple of [signal, observer, clear function]
	 * @throws {TypeError} If fn is not a function
	 */
	computeSignalPush(fn,options={}){
		if(!(fn instanceof Function)) throw new TypeError("computeSignalPush fn must be a Function (callback)");
		let computeSignal = options?.signal || this.createSignal(void 0);
		let obs = this.createObserver(options);
		obs.signalsIgnore.add(computeSignal);
		let recordingFn = this.isolateRecording(obs.wrapRecorder(fn));
		let runFn = this.#computeSignalPushListener.bind(this,obs,computeSignal,recordingFn);
		obs.addListener(runFn);
		try{ runFn(); } catch(err){ console.error(err); }
		let result = [ computeSignal, obs, obs.clear.bind(obs) ];
		result[disposeSymbol] = result[2];
		return result;
	}
	
	#computeSignalPushListener(obs,computeSignal,recordingFn){
		obs.clearSignals();
		computeSignal.set(recordingFn());
	}
	
	/**
	 * Creates a PULL-based computed signal.
	 *
	 * PULL-based computed signals only compute their value when read.
	 * 
	 * @param {Function} fn - Callback function that computes the signal value
	 * @param {object} [options={}] - Compute options
	 * @param {boolean} [options.defer=false] - Defer computation
	 * @param {signalInstance} [options.signal] - Pre-existing signal to use
	 * @returns {Array<[signalInstance, signalObserver, Function]>} Tuple of [signal, observer, clear function]
	 * @throws {TypeError} If fn is not a function
	 */
	computeSignalPull(fn,options={}){
		if(!(fn instanceof Function)) throw new TypeError("computeSignalPull fn must be a Function (callback)");
		let computeSignal = options?.signal || this.createSignal(void 0);
		let obs = this.createObserver(options);
		obs.signalsIgnore.add(computeSignal);
		let state = { isUpdating: false }
		let recordingFn = this.isolateRecording(obs.wrapRecorder(fn));
		computeSignal.addPullListener(this.#computeSignalPullListener.bind(this,obs,computeSignal,recordingFn));
		obs.addListener(this.#computeSignalPullUpdater.bind(this,state,computeSignal));
		computeSignal.invalidatePull();
		let result = [ computeSignal, obs, obs.clear.bind(obs) ];
		result[disposeSymbol] = result[2];
		return result;
	}
	
	#computeSignalPullListener(obs,computeSignal,recordingFn){
		obs.clearSignals();
		computeSignal.set(recordingFn());
	}
	
	#computeSignalPullUpdater(state,computeSignal,depObserver,depSignal,oldValue,newValue){
		if(state.isUpdating) return;
		state.isUpdating = true;
		computeSignal.invalidatePull();
		computeSignal.changed(oldValue);
		state.isUpdating = false;
	}
	
	/**
	 * Alias that creates a computed signal (PUSH or PULL based).
	 * 
	 * @param {Function} fn - Compute callback function
	 * @param {object} [options={}] - Computed signal options
	 * @param {boolean} [options.pull=true] - Use PULL-based computation
	 * @returns {Array<[signalInstance, signalObserver, Function]>} Tuple of [signal, observer, clear function]
	 * @throws {TypeError} If fn is not a function
	 * @see {@link computeSignalPull} signalController.computeSignalPull method
	 * @see {@link computeSignalPush} signalController.computeSignalPush method
	 */
	computeSignal(fn,options={}){
		options = { __proto__:null, pull:true, ...options };
		return options.pull ? this.computeSignalPull(fn,options) : this.computeSignalPush(fn,options);
	}
	
	/**
	 * Creates a deep reactive proxy for objects with automatic signal tracking.
	 *
	 * A signalProxy creates a proxy that automatically creates signalInstance and
	 * signalProxy for every property accessed, enabling infinitely deep reactivity.
	 * Each nested property becomes a signal that can be tracked and updated independently.
	 * The proxy supports arrays, Maps, Sets, and other iterable collections with special
	 * handling for their methods.
	 * 
	 * @param {object} value - Object to proxy (must be an object, not a primitive)
	 * @param {signalInstance} [signal=null] - Pre-existing signal for the target
	 * @param {boolean} [useWeakRef=false] - Use WeakRef (defaults to true for nested proxies)
	 * @returns {signalProxy} Proxy of the passed in value
	 * @throws {TypeError} If value is a primitive
	 * @see {@link defineProxySignal} signalController.defineProxySignal method
	 * @see {@link signalProxy} signalProxy class
	 */
	proxySignal(value,signal=null,useWeakRef=false){
		if(value!==Object(value)) throw new TypeError("proxySignal target must not be a primitive");
		return new signalProxy(value,this,signal,useWeakRef);
	}
	
	/**
	 * Creates a signalProxy and defines a getter/setter on the target object.
	 * 
	 * @param {object} obj - Target object to define the property on
	 * @param {string} prop - Property name to define
	 * @param {object} value - Object value to proxy (must be an object, not a primitive)
	 * @param {signalInstance} [signal=null] - Pre-existing signal for the value
	 * @param {boolean} [silentFallback=false] - Define primitives without signal proxy
	 * @returns {signalProxy} Proxy of the passed in value, or undefined if silentFallback with primitive value
	 * @throws {TypeError} If value is a primitive (use defineSignal instead)
	 * @see {@link proxySignal} signalController.proxySignal method
	 * @see {@link signalProxy} signalProxy class
	 */
	defineProxySignal(obj,prop,value,signal=null,silentFallback=false){
		if(!silentFallback && value!==Object(value)) throw new TypeError("defineProxySignal target must not be a primitive, try defineSignal instead");
		if(!signal) signal = new signalInstance(this,value);
		let set, state = { value };
		if(value===Object(value)){
			value = new signalProxy(value,this,signal);
			set = this.#defineProxySignalSetter.bind(this,signal,obj,prop);
		} else {
			set = this.#defineProxySignalSetterFallback.bind(this,state,signal,obj,prop);
		}
		let get = this.#defineProxySignalGetter.bind(this,signal,state);
		get[signalSymb] = set[signalSymb] = signal;
		mtCacheDefineProperty(obj,prop,{ __proto__:null, configurable:true, enumerable:true, get, set });
		signal.record(); signal.set(value);
		return value;
	}
	
	#defineProxySignalGetter(signal,state){
		signal.record();
		return state.value;
	}
	
	#defineProxySignalSetter(signal,obj,prop,newValue){
		this.defineProxySignal(obj,prop,newValue,signal,true);
		return true;
	}
	
	#defineProxySignalSetterFallback(state,signal,obj,prop,newValue){
		if(newValue===Object(newValue)) this.defineProxySignal(obj,prop,newValue,signal,true);
		else signal.set(state.value=newValue);
		return true;
	}
	
}
