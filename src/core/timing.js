
import {
	resolvedPromise, originalDefer,
} from "./utils.js";

// Defer / Queue Task Variables
let deferList = new Set(), isDeferQueued = false;

// Queue Compute Variables
let computeList = new Set(), isComputeQueued = false, deferCompute = false;

// Queue Render Animation Variables
let rafList=new Set(), rafOnceList=new Map(), isDuringRAF=false, isRAFScheduled=false;

/**
 * @class timing
 */
export class timing {
	
	/**
	 * Defer / Queue a microtask (batched)
	 * @param {Function} fn Function/Task to queue
	 */
	static deferTask(fn){
		deferList.add(fn);
		if(!isDeferQueued){
			isDeferQueued = true;
			originalDefer(timing.#handleDeferredQueue);
		}
	}
	
	static #handleDeferredQueue(){
		isDeferQueued = false;
		if(deferList.size===0) return;
		let list = Array.from(deferList); deferList.clear();
		for(let cb of list) try{ cb(); }catch(err){ console.error(err); }
	}
	
	// - - - - - - - - - - - - - - - - - - - - - - - - - - - -
	
	static deferNextCompute(){
		deferCompute = true;
	}
	
	static queueCompute(fn){
		if(fn) computeList.add(fn);
		if(!isComputeQueued){
			isComputeQueued = true;
			if(isDeferQueued || deferCompute) originalDefer(timing.#handleQueue);
			// setTimeout 0 runs compute functions right after animation frame (if any), before next frame
			else setTimeout(timing.#handleQueue,0);
		}
	}
	
	static async #handleQueue(){
		if(!isRAFScheduled) timing.requestAnimation();
		timing.#handleComputeQueue();
		for(let i=0; i<3 && (deferList.size>0 || computeList.size>0); i++) await timing.#handleComputeQueue();
		isComputeQueued = false;
		deferCompute = false;
	}
	
	static #handleComputeQueue(){
		if(computeList.size===0) return;
		let list = Array.from(computeList); computeList.clear();
		for(let cb of list) try{ cb(); }catch(err){ console.error(err); }
	}
	
	// - - - - - - - - - - - - - - - - - - - - - - - - - - - -
	
	static queueComputeThenRender(computeFn=null,renderFn=null){
		let state = {
			computeFn, renderFn, result:null,
			ranCompute:false, ranRender:false, schRender:false,
		};
		timing.queueCompute(timing.#handleOnCompute.bind(null,state));
	}
	
	static queueRender(fn){
		timing.queueComputeThenRender(null,fn);
	}
	
	static #handleOnCompute(state){
		let { computeFn, renderFn, ranCompute, ranRender, schRender } = state;
		if(!schRender && renderFn) schRender = timing.requestAnimation(timing.#handleOnRender.bind(null,state)), true;
		if(ranRender || ranCompute || !computeFn) return;
		state.ranCompute = true;
		try{ state.result = computeFn(); }catch(err){ console.error(err); }
	}
	
	static #handleOnRender(state){
		let { computeFn, renderFn, result, ranCompute, ranRender } = state;
		if(ranRender) return;
		if(!ranCompute && computeFn) onCompute();
		state.ranRender = true;
		try{ state.renderFn(result); }catch(err){ console.error(err); }
	}
	
	// - - - - - - - - - - - - - - - - - - - - - - - - - - - -
	
	static get isDuringRAF(){ return isDuringRAF; };
	static get isRAFScheduled(){ return isRAFScheduled; };
	static promiseToRAF(p,fn,fnErr){
		return p.then((r)=>timing.requestAnimation(()=>fn(r)),(err)=>timing.requestAnimation(fnErr?fnErr:()=>console.error(err)));
	}
	
	/**
	 * Batched version of {@link requestAnimationFrame}
	 * 
	 * @param {Function} fn Function to run on animation frame
	 */
	static requestAnimation(fn){
		if(fn) rafList.add(fn);
		if(!isRAFScheduled) isRAFScheduled = requestAnimationFrame(timing.#scheduledRAF),true;
	}
	
	/**
	 * Call one callback on {@link requestAnimationFrame}, unique by obj+key. Last callback only, unless useLast=false to use first callback.
	 * 
	 * @param {any} obj Unique Object, eg: HTMLElement
	 * @param {any|string} key Unique Key, eg: String, Object, Symbol
	 * @param {Function} fn Function to run once on animation frame
	 * @param {boolean} [useLast=true] True = For any one unique key, only the last callback will be used, False = the first callback
	 * @returns {boolean} True if callback was added to queue
	 */
	static onceAnimation(obj,key,fn,useLast=true){
		if(obj===void 0 || obj===null) obj = timing.onceAnimation;
		if(key===void 0 || key===null) key = 0;
		let list = rafOnceList.get(obj);
		if(!list) rafOnceList.set(obj,(list=new Map()));
		let hasFn = list.has(key);
		if(useLast && hasFn) list.set(key,fn);
		else if(!hasFn) list.set(key,fn);
		if(!isRAFScheduled) isRAFScheduled = requestAnimationFrame(timing.#scheduledRAF),true;
		return !hasFn; // True if fresh (last cb)
	};
	
	static #scheduledRAF(){
		isDuringRAF = true;
		let list = Array.from(rafList); rafList.clear();
		let list2 = Array.from(rafOnceList.values()); rafOnceList.clear();
		for(let cb of list) try{ cb(); }catch(err){ console.error(err); }
		for(let s of list2) for(let [k,cb] of s) try{ cb(); }catch(err){ console.error(err); }
		isRAFScheduled = false;
		originalDefer(timing.#endRAF);
	}
	
	static #endRAF(){ isDuringRAF=false; }
	
	
}
