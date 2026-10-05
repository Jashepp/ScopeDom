
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

export class attrScope {
	
	/**
	 * $scope attribute handler: inline scope object expression or named controller.
	 * 
	 * Creates a new scope for the element. All children walk up to access this scope.
	 * If $scope:isolate is set, the scope is isolated from parent chains (reachable only via $scopeParent/$scopeTop).
	 * The expression is evaluated in the parent scope context so it can reference parent variables.
	 * $scopeElement is injected into the scope for self-reference.
	 * 
	 * @param {HTMLElement} element The element to attach the scope to
	 * @param {scopeElementController} elementScopeCtrl The current element scope controller
	 * @param {scopeElementAttribDefaults|null} scopeAttrib The inline $scope attribute definition
	 * @param {scopeElementAttribDefaults|null} scopeNamedAttrib The $scope-name attribute definition
	 */
	static attrScope(instance,element,elementScopeCtrl,scopeAttrib,scopeNamedAttrib){
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
	
}
