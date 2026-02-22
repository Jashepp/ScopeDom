
export function noopFn(){};
export async function noopAsyncFn(){};

export const deferFn = Promise.prototype.then.bind(Promise.resolve());
export const { getPrototypeOf, getOwnPropertyDescriptor, defineProperty, hasOwn } = Object;

// Call multiple callbacks on Animation Frame
let rAFList=new Set(), onceRAFList=new Map(), isDuringRAF=false, isScheduled=false;
function scheduledRAF(){
	isDuringRAF = true;
	let list=[...rAFList.values()]; rAFList.clear();
	for(let cb of list) try{ cb(); }catch(err){ console.error(err); }
	let list2=[...onceRAFList.values()]; onceRAFList.clear();
	for(let s of list2) for(let [k,cb] of s) try{ cb(); }catch(err){ console.error(err); }
	isScheduled = false;
	deferFn(()=>{ isDuringRAF=false; });
}

// animUtils
export class animFrameHelper {
	static get isDuringRAF(){ return isDuringRAF; };
	static get isScheduled(){ return isScheduled; };
	static requestAF(cb){
		rAFList.add(cb);
		if(!isScheduled) isScheduled=requestAnimationFrame(scheduledRAF),true;
	};
	// Call one callback on Animation Frame, unique by obj+key. First cb only, unless useLast to use last cb called with
	static onceRAF(obj,key,cb,useLast=true){
		if(obj===void 0 || obj===null) obj = animFrameHelper.onceRAF;
		if(key===void 0 || key===null) key = 0;
		let list = onceRAFList.get(obj);
		if(!list) onceRAFList.set(obj,(list=new Map()));
		let hasCB = list.has(key);
		if(useLast && hasCB) list.set(key,cb);
		else if(!hasCB) list.set(key,cb);
		if(!isScheduled) isScheduled=requestAnimationFrame(scheduledRAF),true;
		return !hasCB; // True if fresh (first cb)
	};
	static promiseToRAF(p,cb,cbErr){
		return p.then((r)=>animFrameHelper.requestAF(()=>cb(r)),(err)=>animFrameHelper.requestAF(cbErr?cbErr:()=>console.error(err)));
	}
}

// regexUtils
export function regexMatchAll(str,r){ return str.matchAll(r); } // matchAll clones regex, and doesn't need lastIndex=0
export function regexExec(str,r){ r.lastIndex=0; return r.exec(str); };
export function regexTest(str,r){ r.lastIndex=0; return r.test(str); };
export function regexMatchAllFirstGroup(str,regex){
	let match, matches=[]; regex.lastIndex=0;
	while(match=regex.exec(str)) matches.push(match[1]);
	return matches;
}


export const elementNodeType = document.ELEMENT_NODE;
export const commentNodeType = document.COMMENT_NODE;
export const textNodeType = document.TEXT_NODE;

export const objectProto = getPrototypeOf(Object()); // window.Object===objectProto.constructor
export const nodeProto = getPrototypeOf(getPrototypeOf(getPrototypeOf(document.createTextNode('text'))));
export const elementProto = getPrototypeOf(getPrototypeOf(getPrototypeOf(document.createElement('div'))));
export const functionProto = getPrototypeOf(noopFn);
export const functionAsyncProto = getPrototypeOf(noopAsyncFn);
export const nativeProtos = [objectProto,nodeProto,elementProto,functionProto,functionAsyncProto];
export const nativeConstructors = nativeProtos.map(p=>p?.constructor);
export function isNative(obj){ return nativeProtos.indexOf(obj)!==-1 || nativeConstructors.indexOf(obj)!==-1; }
export function scopeAllowed(obj){ return obj && !isNative(obj); }


export const defineWeakRef = (target,prop,value=target[prop])=>{
	if(!window.WeakRef) return target[prop]=value, target;
	let ref = new WeakRef(value);
	defineProperty(target,prop,{ get(){ return ref.deref(); }, set(v){ ref=new WeakRef(v); } });
	return target;
};


export const isElementLoaded = (()=>{
	let domState=0, listener = ()=>{
		if(document.readyState==='interactive') domState=1;
		else if(document.readyState==='complete'){ domState=2; document.removeEventListener("readystatechange",listener); }
	};
	document.addEventListener("readystatechange",listener,{ capture:true, passive:true, once:false });
	return function isElementLoaded(element,hasChildNodes=false,partial=false){
		if(partial && domState===1) return true;
		else if(domState===2) return true;
		if(element.nodeType===textNodeType && element.nextSibling && element.nextSibling.nodeType!==textNodeType) return true;
		if(hasChildNodes && (element?.childNodes?.length>0 || element?.content?.childNodes?.length>0)) return true;
		for(let e=element; e; e=e.parentNode) if(e.nextSibling) return true;
		return false;
	};
})();

export function setAttribute(target,name,value){ // Set attribute with less name limitations
	try{ target.setAttribute(name,value); }
	catch(e){
		let t=document.createElement('template'); t.innerHTML=`<span ${name}=""></span>`;
		let a=t.content.firstChild.attributes.item(name).cloneNode(false); a.value=value;
		target.attributes.setNamedItem(a);
	}
}


export class eventRegistry {
	constructor(){
		this.map = new Map();
	}
	add(target,name,listener,options={}){
		let targetMap = this.map;
		if(!targetMap.has(target)) targetMap.set(target,new Map());
		let nameMap = targetMap.get(target);
		if(!nameMap.has(name)) nameMap.set(name,new Map());
		let listenerMap = nameMap.get(name);
		if(!listenerMap.has(listener)) listenerMap.set(listener,new Set());
		let optionsSet = listenerMap.get(listener);
		optionsSet.add(options);
		target.addEventListener(name,listener,options);
	}
	remove(target,name=null,listener=null,options=null){
		if(!this.map.has(target)) return;
		let nameMap = this.map.get(target);
		if(name===null){
			for(const [keyN,listenerMap] of nameMap) for(const [keyL,optionsSet] of listenerMap) for(const opts of optionsSet) target.removeEventListener(keyN,keyL,opts);
		}
		else if(nameMap.has(name)){
			let listenerMap = nameMap.get(name);
			if(listener===null){
				for(const [keyL,optionsSet] of listenerMap) for(const opts of optionsSet) target.removeEventListener(name,keyL,opts);
			}
			else if(listenerMap && listenerMap.has(listener)){
				let optionsSet = listenerMap.get(listener);
				if(options===null){
					for(const opts of optionsSet) target.removeEventListener(name,listener,opts);
				}
				else if(optionsSet.has(options)){
					target.removeEventListener(name,listener,options);
					optionsSet.delete(options);
				}
				if(optionsSet.size===0) listenerMap.delete(listener);
			}
			if(listenerMap && listenerMap.size===0) nameMap.delete(name);
		}
		if(nameMap.size===0) this.map.delete(target);
	}
}
