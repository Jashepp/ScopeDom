
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
 * Signal Controller - the central orchestrator of the reactive signal system.
 * 
 * The signal controller is the brain of reactive dataflow in ScopeDom. Every signal,
 * observer, and computed value goes through this class. It maintains the registry
 * of all observers (via `#observers`) and the current set of observers that are
 * in recording mode via `#observersRecording`, which determines which signals a
 * computed expression depends on.
 * 
 * The controller exposes methods for:
 * - Creating {@link signalInstance} objects - that hold reactive values.
 * - Creating {@link signalObserver} objects - dependency trackers that record which
 *   signals they depend on during a computation and react when any of those signals change.
 * - Creating computed signals - signals whose value is derived from other signals.
 *   PUSH-based computations re-evaluate automatically when any dependency changes,
 *   while PULL-based computations re-evaluate only when their value is read.
 * - Defining signals on object properties via getters/setters (both with and
 *   without original getter/setter wrappers).
 * - Creating deep reactive proxies via {@link signalProxy} for objects and arrays,
 *   enabling infinitely-nested reactivity without manual signal declarations.
 * - Temporarily suspending signal activity via `preventUpdates(fn)`, `preventObservers(fn)`,
 *   and the `using` keyword equivalents (`preventUpdatesScope()`, etc.).
 * - Isolating signal recording context via `isolateRecording(fn)` so that nested
 *   computations don't accidentally record signals on sibling observers.
 * 
 * @class signalController
 * @property {scopeController} scopeCtrl - The parent scope controller that this signal controller belongs to
 * 
 * @see {@link signalObserver} - Signal Observer for tracking signal dependencies
 * @see {@link signalInstance} - Signal Instance that represents a reactive signal value
 * @see {@link signalProxy} - Signal Proxy for deep reactivity for objects with automatic signal tracking
 */
export class signalController {
	
	/** @type {boolean} Internal flag to prevent observer update triggers during sensitive operations */
	#preventUpdates = false;
	
	/** @type {boolean} Internal flag to prevent observers from recording signals during sensitive operations */
	#preventObservers = false;
	
	/** @type {Array<object>} Array of observers currently in recording mode (tracking their accessed signals as dependencies) */
	#observersRecording = [];
	
	/** @type {Array<object>} Array of all registered observers managed by this controller */
	#observers = [];
	
	/**
	 * Constructs a new signalController with a reference to the parent scope controller.
	 * 
	 * If a scopeElementController is provided, it extracts the underlying signalController.
	 * 
	 * @constructor
	 * @param {scopeController|scopeElementController} scopeCtrl The parent scope controller
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
	 * @param {object} options Observer configuration options (see {@link signalObserver})
	 * @returns {signalObserver} The newly created signalObserver instance (also added to this controller's observers set)
	 */
	createObserver(options={}){ let o=new signalObserver(this,options); this.#observers.push(o); return o; }
	
	/**
	 * Removes a signalObserver from the controller.
	 * 
	 * @param {signalObserver} observer The observer to remove
	 * @param {boolean} [clear=true] Clear the observer's signals and listeners
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	removeObserver(observer,clear=true){
		if(!(observer instanceof signalObserver)) throw new TypeError("removeObserver observer must be a signalObserver");
		let obsIdx = this.#observers.indexOf(observer);
		if(obsIdx!==-1) this.#observers.splice(obsIdx,1);
		let obsRIdx = this.#observersRecording.indexOf(observer);
		if(obsRIdx!==-1) this.#observersRecording.splice(obsRIdx,1);
		if(clear) observer.clear();
	}
	
	/**
	 * Begins recording signals for a specific observer.
	 * 
	 * Signals accessed while an observer is in recording mode are tracked as dependencies.
	 * 
	 * @param {signalObserver} observer The observer to start recording for
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	startObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("startObserverRecording observer must be a signalObserver");
		this.#observersRecording.push(observer);
	}
	
	/**
	 * Stops recording signals for a specific observer.
	 * 
	 * @param {signalObserver} observer The observer to stop recording for
	 * @throws {TypeError} If observer is not a signalObserver instance
	 */
	stopObserverRecording(observer){
		if(!(observer instanceof signalObserver)) throw new TypeError("stopObserverRecording observer must be a signalObserver");
		let obsRIdx = this.#observersRecording.indexOf(observer);
		if(obsRIdx!==-1) this.#observersRecording.splice(obsRIdx,1);
	}
	
	/**
	 * Triggers a change notification to all observers that have the given signal recorded.
	 * 
	 * When a signal changes value, it calls this method which then notifies all dependent observers via {@link signalObserver.triggerChange}.
	 * Dependent observers always fire deferred via {@link timing.deferTask}; observers never run immediately or during the current task.
	 * 
	 * @param {signalInstance} signal The signal that changed
	 * @param {any} oldValue The previous value before the change
	 * @param {any} newValue The new value after the change
	 * @throws {TypeError} If signal is not a signalInstance instance
	 */
	triggerChange(signal,oldValue,newValue){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerChange signal must be a signalInstance");
		if(!this.#preventUpdates) for(let i=0,l=this.#observers.length,o; o=this.#observers[i], i<l; i++){
			if(o.hasSignal(signal)) o.triggerChange(signal,oldValue,newValue);
		}
	}
	
	/**
	 * Triggers the specified signal to be recorded on currently recording observers, as a dependency.
	 * 
	 * @param {signalInstance} signal The signal to record on observers
	 * @throws {TypeError} If signal is not a signalInstance instance
	 */
	triggerRecording(signal){
		if(!(signal instanceof signalInstance)) throw new TypeError("triggerRecording signal must be a signalInstance");
		if(!this.#preventObservers) for(let i=0,l=this.#observersRecording.length,o; o=this.#observersRecording[i], i<l; i++){
			o.recordSignal(signal);
		}
	}
	
	/**
	 * This method wraps a function in a context where signal recording is temporarily disabled for existing observers.
	 * Used internally by {@link computeSignalPush} & {@link computeSignalPull}.
	 * 
	 * The returned wrapper captures the current set of recording observers, clears them, executes the function, then restores them.
	 * This prevents nested operations from accidentally recording signals on observers that shouldn't see them during computation.
	 * 
	 * @param {Function} fn Function to run in isolated recording context
	 * @returns {Function} A wrapped function that captures and restores recording observers (executes in isolated recording mode)
	 * @throws {TypeError} If fn is not a Function
	 */
	isolateRecording(fn){
		if(!(fn instanceof Function)) throw new TypeError("isolateRecording fn must be a Function (callback)");
		return this.#isolatedSignalRecording.bind(this,fn);
	}
	
	/**
	 * Run `fn` with recording observer state isolated.
	 * 
	 * Shelves current recording observers, clears them, runs `fn` with args, then restores them.
	 * Prevents nested operations from accidentally recording signals on observers that shouldn't see them.
	 * Thrown errors from `fn` are caught and logged via `console.error` (not rethrown); isolates recording from the surrounding computation.
	 * 
	 * @private
	 * @param {Function} fn Callback to execute in isolated recording mode
	 * @param {...*} args Arguments passed to `fn`
	 * @returns {any} Result of `fn`
	 */
	#isolatedSignalRecording(fn,...args){
		let prev = Array.from(this.#observersRecording);
		this.#observersRecording.length = 0;
		let result; try{ result=fn(...args); }catch(err){ console.error(err); }
		for(let observer of prev) this.#observersRecording.push(observer);
		return result;
	}
	
	/**
	 * Enables `using` keyword to automatically start/stop an isolated recording mode for a block of code.
	 * 
	 * Note: This is identical to {@link isolateRecording}, without the function wrapper.
	 * 
	 * @example
	 * {
	 *   // Isolation starts, existing recording observers are shelved
	 *   using _ = signalCtrl.isolatedRecordingScope();
	 *   // ... something that calls signalCtrl.triggerRecording under the hood
	 *   // Isolation stops, previously recording observers are restored
	 * }
	 * 
	 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using
	 */
	isolatedRecordingScope(){
		let prev = Array.from(this.#observersRecording);
		this.#observersRecording.length = 0;
		return { __proto__:null, [disposeSymbol]:()=>{
			for(let observer of prev) this.#observersRecording.push(observer);
		} };
	}
	
	/**
	 * Prevents signals from triggering updates to observers during function execution.
	 * 
	 * This creates a temporary "quiet zone" where signal changes don't propagate to observers.
	 * Useful when you need to modify signals without triggering cascading updates, such as during initialisation.
	 * 
	 * @param {Function} fn Function to run without triggering observer updates
	 * @param {...*} args Arguments to pass to the function
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
	 * Enables `using` keyword to automatically prevent signals from triggering updates to observers, for a block of code.
	 * 
	 * Note: This is identical to {@link preventUpdates}, without the function wrapper.
	 * 
	 * @example
	 * {
	 *   // Signal updates disabled
	 *   using _ = signalCtrl.preventUpdatesScope();
	 *   // ... update signals
	 *   // Signal updates enabled
	 * }
	 * 
	 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using
	 */
	preventUpdatesScope(){
		this.#preventUpdates = true;
		return { __proto__:null, [disposeSymbol]:()=>{
			this.#preventUpdates = false;
		} };
	}
	
	/**
	 * Prevents observers from recording signals during function execution.
	 * 
	 * This creates a temporary "quiet zone" where recording observers don't record new signal dependencies.
	 * Existing tracked signals will still trigger updates.
	 * 
	 * @param {Function} fn Function to run without observers recording signals
	 * @param {...*} args Arguments to pass to the function
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
	
	/**
	 * Enables `using` keyword to automatically prevent observers from recording signals, for a block of code.
	 * 
	 * Note: This is identical to {@link preventObservers}, without the function wrapper.
	 * 
	 * @example
	 * {
	 *   // Signal dependency tracking disabled
	 *   using _ = signalCtrl.preventObserversScope();
	 *   // ... access signals
	 *   // Signal dependency tracking enabled
	 * }
	 * 
	 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using
	 */
	preventObserversScope(){
		this.#preventObservers = true;
		return { __proto__:null, [disposeSymbol]:()=>{
			this.#preventObservers = false;
		} };
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
	 * @param {any} value Initial signal value (cannot be Array, Map, or Set)
	 * @param {boolean} [useWeakRef=false] Use WeakRef for the value. It must be referenced elsewhere otherwise it may vanish on a GC event
	 * @returns {signalInstance} The created signal instance
	 * @throws {TypeError} If value is an Array, Map, or Set (use proxySignal instead)
	 */
	createSignal(value=void 0,useWeakRef=false){
		if(value instanceof Array) throw new TypeError("createSignal value is an Array, use proxySignal instead");
		if(value instanceof Map) throw new TypeError("createSignal value is a Map, use proxySignal instead");
		if(value instanceof Set) throw new TypeError("createSignal value is a Set, use proxySignal instead");
		let signal = new signalInstance(this,value,useWeakRef);
		return signal.record(), signal;
	}
	
	/**
	 * Creates a signalInstance and defines a getter/setter on the target object.
	 * 
	 * @param {object} obj Target object to define the property on
	 * @param {string} prop Property name to define
	 * @param {signalInstance|any} [value=void 0] Initial signal value or existing signal instance
	 * @param {PropertyDescriptor|object} [descriptor={}] Property descriptor options
	 * @param {boolean} [useOriginal=true] Use existing getter/setter
	 * @returns {signalInstance} The created or provided signal instance
	 */
	defineSignal(obj,prop,value=void 0,descriptor={},useOriginal=true){
		let { configurable=true, enumerable=true, get:oGet=null, set:oSet=null } = { __proto__:null, ...descriptor };
		let signal = value instanceof signalInstance ? value : this.createSignal(value), sGet, sSet;
		if(useOriginal && oGet){
			sGet = this.#defineSignalGetterWrapper.bind(this,signal,oGet,obj);
		}
		if(useOriginal && oSet){
			sSet = this.#defineSignalSetterWrapper.bind(this,signal,oSet,obj);
		}
		if(!sGet) sGet = signal.get.bind(signal);
		if(!sSet) sSet = signal.set.bind(signal);
		sGet[signalSymb] = sSet[signalSymb] = signal;
		mtCacheDefineProperty(obj,prop,{ __proto__:null, configurable, enumerable, get:sGet, set:sSet });
		return signal;
	}
	
	/**
	 * Define getter wrapper: applies original getter, then sets signal.
	 * 
	 * @private
	 * @param {signalInstance} signal The signal to set after original getter runs
	 * @param {Function} oGet Original getter function
	 * @param {object} obj Object the getter is bound to
	 * @returns {any} Signal's value after the original getter runs
	 */
	#defineSignalGetterWrapper(signal,oGet,obj){
		signal.set(oGet.apply(obj));
		return signal.get();
	}
	
	/**
	 * Define setter wrapper: applies original setter (if any), then sets signal.
	 * 
	 * @private
	 * @param {signalInstance} signal The signal to set after original setter runs
	 * @param {Function} oSet Original setter function (may be null)
	 * @param {object} obj Object the setter is bound to
	 * @param {any} v New value
	 * @returns {any} Signal's value after the original setter runs
	 */
	#defineSignalSetterWrapper(signal,oSet,obj,v){
		if(oSet) v = oSet.apply(obj,[v]);
		return signal.set(v);
	}
	
	/**
	 * Defines signals for each property from a source object and assigns them to target.
	 * 
	 * @param {object} target Target object to assign signals to
	 * @param {object} source Source object to copy properties from
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
	 * @param {Function} fn Callback function that computes the signal value
	 * @param {object} [options={}] Compute options
	 * @param {signalInstance} [options.signal] Pre-existing signal to use
	 * @returns {[signalInstance, signalObserver, Function]} Tuple of [signal, observer, clear function]
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
	
	/**
	 * PUSH listener: clears recording, re-runs fn in isolated mode, and sets computed signal.
	 * 
	 * Called by the PUSH observer when any dependency changes.
	 * 
	 * @private
	 * @param {signalObserver} obs The observer that triggered this
	 * @param {signalInstance} computeSignal The computed signal to update
	 * @param {Function} recordingFn Isolated recording function to execute
	 */
	#computeSignalPushListener(obs,computeSignal,recordingFn){
		obs.clearSignals();
		computeSignal.set(recordingFn());
	}
	
	/**
	 * Creates a PULL-based computed signal.
	 * 
	 * PULL-based computed signals only compute their value when read.
	 * 
	 * @param {Function} fn Callback function that computes the signal value
	 * @param {object} [options={}] Compute options
	 * @param {signalInstance} [options.signal] Pre-existing signal to use
	 * @returns {[signalInstance, signalObserver, Function]} Tuple of [signal, observer, clear function]
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
	
	/**
	 * PULL listener: clears recording, re-runs fn in isolated mode, and sets computed signal.
	 * 
	 * Called by pull listener when the computed signal is read.
	 * 
	 * @private
	 * @param {signalObserver} obs The observer that triggered this
	 * @param {signalInstance} computeSignal The computed signal to update
	 * @param {Function} recordingFn Isolated recording function to execute
	 */
	#computeSignalPullListener(obs,computeSignal,recordingFn){
		obs.clearSignals();
		computeSignal.set(recordingFn());
	}
	
	/**
	 * PULL updater listener: invalidates and changes the computed signal when any dependency changes.
	 * 
	 * Prevents re-entrant updates via `state.isUpdating` flag.
	 * 
	 * @private
	 * @param {object} state State object with `isUpdating` flag
	 * @param {signalInstance} computeSignal The computed signal to update
	 * @param {signalObserver} depObserver The dependency observer that triggered
	 * @param {signalInstance} depSignal The dependency signal that changed
	 * @param {any} oldValue Previous value of the dependency
	 * @param {any} newValue New value of the dependency
	 */
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
	 * @param {Function} fn Compute callback function
	 * @param {object} [options={}] Computed signal options
	 * @param {boolean} [options.pull=true] Use PULL-based computation (default)
	 * @returns {[signalInstance, signalObserver, Function]} Tuple of [signal, observer, clear function]
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
	 * @param {object} value Object to proxy (must be an object, not a primitive)
	 * @param {signalInstance} [signal=null] Pre-existing signal for the target
	 * @param {boolean} [useWeakRef=false] Use WeakRef (defaults to true for nested proxies)
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
	 * @param {object} obj Target object to define the property on
	 * @param {string} prop Property name to define
	 * @param {object} value Object value to proxy (must be an object, not a primitive)
	 * @param {signalInstance} [signal=null] Pre-existing signal for the value
	 * @param {boolean} [silentFallback=false] Define primitives without signal proxy
	 * @returns {signalProxy|any} Proxy of the passed in value, or the primitive value passed through with silentFallback
	 * @throws {TypeError} If value is a primitive (use defineSignal instead), unless silentFallback is true
	 * @see {@link proxySignal} signalController.proxySignal method
	 * @see {@link signalProxy} signalProxy class
	 */
	defineProxySignal(obj,prop,value,signal=null,silentFallback=false){
		if(!silentFallback && value!==Object(value)) throw new TypeError("defineProxySignal target must not be a primitive, try defineSignal instead");
		let set, state = { __proto__:null, value };
		if(value===Object(value)){
			value = new signalProxy(value,this,signal);
			if(!signal) signal = signalProxy._getProxySignal(value);
			set = this.#defineProxySignalSetter.bind(this,state,signal,obj,prop);
		} else {
			if(!signal) signal = new signalInstance(this,void 0);
			set = this.#defineProxySignalSetterFallback.bind(this,state,signal,obj,prop);
		}
		let get = this.#defineProxySignalGetter.bind(this,state,signal);
		get[signalSymb] = set[signalSymb] = signal;
		mtCacheDefineProperty(obj,prop,{ __proto__:null, configurable:true, enumerable:true, get, set });
		signal.record(); signal.set(value);
		return value;
	}
	
	/**
	 * Define proxy signal getter: records signal access, returns current value.
	 * 
	 * @private
	 * @param {object} state State object holding the current value
	 * @param {signalInstance} signal The signal to record access on
	 * @returns {any} Current stored value
	 */
	#defineProxySignalGetter(state,signal){
		return signal.get();
	}
	
	/**
	 * Define proxy signal setter: redefines the property with new value via `defineProxySignal`.
	 * 
	 * Uses silentFallback=true to avoid re-entrant errors.
	 * 
	 * @private
	 * @param {object} state State object holding the current value (discarded)
	 * @param {signalInstance} signal The existing signal
	 * @param {object} obj Object to redefine property on
	 * @param {string} prop Property name
	 * @param {any} newValue New value
	 * @returns {true} Always returns true
	 */
	#defineProxySignalSetter(state,signal,obj,prop,newValue){
		this.defineProxySignal(obj,prop,state.value=newValue,signal,true);
		return true;
	}
	
	/**
	 * Define proxy signal setter fallback: redefines if object-type, else sets signal on primitive.
	 * 
	 * @private
	 * @param {object} state State object holding current value
	 * @param {signalInstance} signal The signal to update
	 * @param {object} obj Object to redefine property on
	 * @param {string} prop Property name
	 * @param {any} newValue New value
	 * @returns {true} Always returns true
	 */
	#defineProxySignalSetterFallback(state,signal,obj,prop,newValue){
		if(newValue===Object(newValue)) this.defineProxySignal(obj,prop,newValue,signal,true);
		else signal.set(state.value=newValue);
		return true;
	}
	
	/**
	 * Resolve a signalProxy or signalInstance to its underlying raw value.
	 * 
	 * Delegate to signalProxy._resolveSignal. Used to flatten reactive proxies
	 * to their underlying values when needed in expressions or plugins.
	 * 
	 * @param {any} value The signalProxy or signalInstance value to resolve
	 * @param {signalObserver|any} [signalObs=null] Optional observer the resolved signal is recorded on as a dependency (via recordSignal) rather than merely checked against
	 * @param {boolean} [strict=false] Strict mode: throw if value is not a signal
	 * @returns {any} The resolved raw value (unwrapped from signalProxy/signalInstance)
	 */
	resolveSignal(value,signalObs=null,strict=false){
		return resolveSignal(value,signalObs,strict);
	}
	
}
