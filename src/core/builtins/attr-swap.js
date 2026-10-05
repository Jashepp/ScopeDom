
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
import ScopeDom from "../../scopedom.js";

export class attrSwap {
	
	/**
	 * <template $swap> content replacement.
	 * 
	 * Replaces the template element with an anchor comment node and registers an onElementLoaded
	 * callback to swap in the template contents (or a wrapper element if $swap has a value).
	 * No other built-in or plugin attributes are processed on the template element.
	 * 
	 * @param {HTMLElement} element The template element to swap
	 * @param {Map<string,scopeElementAttribDefaults>} attribs Parsed ScopeDom attributes Map
	 */
	static attrSwap(instance,element,attribs){
		let anchor = document.createComment(` Template-Swap-Anchor ${instance.dev?element.cloneNode(false).outerHTML:''} `);
		instance.elementScopeSetAlias(anchor,element);
		element.parentNode.replaceChild(anchor,element);
		instance.onElementLoaded(anchor,attrSwap.attrSwap_onElementLoaded.bind(null,element,attribs,anchor));
	}
	
	/**
	 * onElementLoaded callback for $swap.
	 * 
	 * Removes $swap attribute from template, creates replacement element if $swap has a value,
	 * and replaces the anchor comment with either the new element or the template content fragment.
	 */
	static attrSwap_onElementLoaded(element,attribs,anchor){
		let swap = attribs.get('swap'), fragment=element.content, dom=fragment;
		element.removeAttribute(swap.attribute);
		if(swap?.value?.length>0){
			dom = document.createElement(swap.value);
			for(let a of element.attributes) dom.attributes.setNamedItem(a.cloneNode(false));
			dom.appendChild(fragment);
		}
		anchor.replaceWith(dom);
	}
	
}
