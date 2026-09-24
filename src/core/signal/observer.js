
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

import { signalController } from "./controller.js";
import { signalInstance, signalSymb } from "./instance.js";
import { signalProxy, resolveSignal } from "./proxy.js";

/**
 * Signal Observer - the dependency tracker of the reactive signal system.
 * 
 * A signal observer records which signals it depends on when in "recording mode" and
 * executes deferred registered listeners when any of those signals changes. Observers are
 * the bridge between signal changes and reactive computation - a signal changing triggers
 * the observer via {@link signalController.triggerChange}, and the observer's listeners
 * (connected to computed signals) then re-evaluate the dependency graph.
 * 
 * The flags (`isDeferring`, `isChanging`) implement batching and re-entry prevention:
 * - `isDeferring`: When true, a deferred notification is pending (via
 *   {@link timing.deferTask}). Additional calls to `triggerChange` are dropped
 *   to prevent duplicate executions.
 * - `isChanging`: When true, listeners are currently executing; prevents re-entrant
 *   recursion when a listener itself triggers a change.
 * 
 * @see {@link signalController} - Signal Controller for managing signals and observers
 * @see {@link signalInstance} - Signal Instance that represents a reactive signal value
 * @see {@link signalProxy} - Signal Proxy for deep reactivity for objects with automatic signal tracking
 * 
 * @property {signalController} ctrl - The parent signal controller that manages this observer's lifecycle and notification callbacks
 * @property {WeakSet<signalInstance>} signals - WeakSet of signals this observer depends on (recorded during recording mode)
 * @property {WeakSet<signalInstance>} signalsIgnore - WeakSet of signals to ignore during recording (eg, the signal being computed, to avoid self-dependency)
 * @property {Array<Function>} listeners - Array of listener callbacks invoked when dependent signals change; each called with (observer, signal, oldValue, newValue)
 * @property {boolean} isDeferring - Change notification has been deferred and not yet executed
 * @property {boolean} isChanging - Change notification listeners are currently executing (prevents re-entrant recursion)
 * @property {boolean} isRecording - Observer is currently in recording mode, tracking signal dependencies
 * @class signalObserver
 */
export class signalObserver {
	
	/**
	 * Constructs a new signalObserver, with a reference to the parent signal controller.
	 * 
	 * @param {signalController} signalCtrl The parent signal controller that manages this observer
	 */
	constructor(signalCtrl,options={}){
		// options = { __proto__:null, ...options };
		this.ctrl = signalCtrl;
		this.signals = new WeakSet();
		this.signalsIgnore = new WeakSet();
		this.listeners = [];
		this.isRecording = false;
		this.isChanging = false;
		this.isDeferring = false;
	}
	
	/**
	 * Checks if the observer depends on a specific signal.
	 * 
	 * @param {signalInstance} signal The signal to check
	 * @returns {boolean} True if the observer depends on the signal
	 */
	hasSignal(signal){ return this.signals.has(signal); }
	
	/**
	 * Records a signal as a dependency of this observer.
	 * 
	 * Only records if the signal is not in `signalsIgnore`. Duplicate entries in `signals`
	 * are prevented automatically by WeakSet's idempotent `add`, so no own-membership check is needed. This respects ignored signals during recording mode.
	 * 
	 * @param {signalInstance} signal The signal to record as a dependency
	 */
	recordSignal(signal){
		if(this.signalsIgnore.has(signal)) return;
		this.signals.add(signal);
	}
	
	/**
	 * Triggers change notifications to all registered listeners.
	 * 
	 * Listeners are invoked with the arguments: signalObserver, signalInstance, old value, new value.
	 * 
	 * Notifications are always deferred via {@link timing.deferTask}, rather than fired synchronously, which lets multiple changes be batched together.
	 * 
	 * The `isDeferring`, `isRecording`, and `isChanging` flags below gate this call; see the class-level description for their full meaning.
	 * 
	 * @see {@link #callObserverListeners}
	 * 
	 * @param {signalInstance} signal The signal that changed
	 * @param {any} oldValue The previous value before the change
	 * @param {any} newValue The new value after the change
	 */
	triggerChange(signal,oldValue,newValue){
		if(this.isDeferring || this.isRecording || this.isChanging) return;
		this.isDeferring = true;
		timing.deferTask(this.#callObserverListeners.bind(this,signal,oldValue,newValue));
	}
	
	/**
	 * Call observer listeners with triggered change.
	 * 
	 * Used internally by {@link triggerChange}
	 * 
	 * If `isChanging` is already true (a listener triggered another change) the run is skipped to prevent re-entrant recursion. Listener exceptions are caught and logged via console.error rather than propagated, since this runs inside a deferred {@link timing.deferTask}.
	 * 
	 * @private
	 * @param {signalInstance} signal The signal that changed
	 * @param {any} oldValue The previous value before the change
	 * @param {any} newValue The new value after the change
	 */
	#callObserverListeners(signal,oldValue,newValue){
		if(this.isChanging) return;
		this.isDeferring = false;
		this.isChanging = true;
		for(let i=0,l=this.listeners.length; i<l; i++){
			let listener = this.listeners[i];
			try{ listener(this,signal,oldValue,newValue); } catch(err){ console.error(err); }
		}
		this.isChanging = false;
	}
	
	/**
	 * Starts recording signals for this observer.
	 * 
	 * When an observer is in "recording mode", it captures signal dependencies as they're accessed.
	 * Signal changes will not be triggered during a recording - only dependency tracking occurs.
	 * 
	 * @returns {boolean} True if recording was started, false if already recording
	 */
	startRecording(){
		if(this.isRecording) return false;
		this.isRecording = true;
		this.ctrl.startObserverRecording(this);
		return true;
	}
	
	/**
	 * Stops recording signals for this observer.
	 * 
	 * @returns {boolean} True if recording was stopped, false if not recording
	 */
	stopRecording(){
		if(!this.isRecording) return false;
		this.isRecording = false;
		this.ctrl.stopObserverRecording(this);
		return true;
	}
	
	/**
	 * Wraps a function to only execute within recording mode.
	 * 
	 * The returned wrapper starts recording before executing the wrapped function,
	 * then stops recording after execution completes. This ensures that any signals
	 * accessed during the function's execution are properly captured as dependencies.
	 * 
	 * @param {Function} fn Function to wrap in recording mode
	 * @returns {Function} Wrapped function that starts/stops recording around execution
	 */
	wrapRecorder(fn){
		return this.#signalObserverRecorder.bind(this,fn);
	}
	
	/**
	 * Run `fn` with recording mode started.
	 * 
	 * Starts recording before calling `fn`, stops after (if recording was actually started).
	 * Catches and logs errors from `fn` to prevent recording state corruption.
	 * 
	 * @param {Function} fn Callback to execute in recording mode
	 * @param {...*} args Arguments passed to `fn`
	 * @returns {any} Result of `fn`
	 */
	#signalObserverRecorder(fn,...args){
		let recording = this.startRecording();
		let result; try{ result=fn(...args); }catch(err){ console.error(err); }
		if(recording) this.stopRecording();
		return result;
	}
	
	/**
	 * Enables `using` keyword to automatically start/stop recording mode for a block of code.
	 * 
	 * Note: This is identical to {@link wrapRecorder}, without the function wrapper.
	 * 
	 * @example
	 * {
	 *   // Recording starts
	 *   using _ = observer.recordingScope();
	 *   // ... access/update signals
	 *   // Recording stops
	 * }
	 * 
	 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using
	 * 
	 * @returns {object} A disposable object exposing `[disposeSymbol]` (which stops recording), consumed by the `using` keyword
	 */
	recordingScope(){
		this.startRecording();
		return { __proto__:null, [disposeSymbol]: this.stopRecording.bind(this) };
	}
	
	/**
	 * Adds a listener callback to the observer.
	 * 
	 * Returns a cleanup function that can be called to remove this specific listener.
	 * 
	 * @param {Function} fn Listener callback function (invoked as fn(observer, signal, oldValue, newValue))
	 * @returns {Function} A cleanup function that removes the listener when called
	 */
	addListener(fn){
		let idx = this.listeners.indexOf(fn);
		if(idx===-1) this.listeners.push(fn);
		return this.removeListener.bind(this,fn);
	}
	
	/**
	 * Removes a listener callback from the observer.
	 * 
	 * @param {Function} fn Listener callback function to remove
	 */
	removeListener(fn){
		let idx = this.listeners.indexOf(fn);
		if(idx!==-1) this.listeners.splice(idx,1);
	}
	
	/**
	 * Clears all listeners and signals, and removes the observer from the controller.
	 * This fully disposes of the observer's resources.
	 */
	clear(){
		this.clearListeners();
		this.clearSignals();
		this.ctrl.removeObserver(this,false);
	}
	
	/**
	 * Only clears listeners. Observer remains active in the controller.
	 * Use this when you want to remove all listeners without fully disposing the observer.
	 */
	clearListeners(){
		this.listeners.length = 0;
	}
	
	/**
	 * Only clears signals. Observer remains active in the controller.
	 * Use this when you want to reset dependencies without fully disposing the observer.
	 * 
	 * Used internally by computed signals.
	 */
	clearSignals(){
		this.signals = new WeakSet();
	}
	
	[disposeSymbol] = signalObserver.prototype.clear;
}
