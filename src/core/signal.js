
/**
 * Signal Reactive System
 * 
 * The signal system enables ScopeDom expressions to reactively update when their
 * underlying data changes, without requiring manual $update() calls.
 * 
 * It consists of four components:
 * 
 * 1. signalController: orchestrates observers and proxies. It tracks registered observers
 *    (which signals they depend on) and triggers updates; it does NOT keep a registry of
 *    signal instances - instances are created on demand, not stored centrally.
 *    Provides the central API that scope controllers delegate to for signal creation/management.
 * 
 * 2. signalInstance: The reactive value with get/set semantics. On set, it notifies
 *    all registered signalObserver instances.
 * 
 * 3. signalObserver: Tracks dependencies - a signalObserver records which signals it
 *    accesses, and when any of those signals change, the observer is notified. Used for
 *    computation re-run and expression re-execution.
 * 
 * 4. signalProxy: Wraps a proxy object with signal-aware property access, enabling
 *    automatic dependency tracking when a signalProxy is created.
 * 
 * History: This signal reactive system was not originally a part of the ScopeDom design.
 * Especially the signalProxy, which started as a proof-of-concept, but proved itself as a
 * viable approach for reactive DOM property tracking.
 * That's why ScopeDom can still be used without signals, as this was a bonus feature.
 * 
 * The following references inspired the development and implementation of this system:
 * - https://www.jovidecroock.com/blog/state-models/
 * - https://medium.com/@davletovalmir/what-are-signals-in-js-lets-build-one-and-find-out-0bd917dc0f35
 * - https://willybrauner.com/journal/signal-the-push-pull-based-algorithm
 * - https://github.com/preactjs/signals
 */

import { signalController } from "./signal/controller.js";
import { signalObserver } from "./signal/observer.js";
import { signalInstance, signalSymb } from "./signal/instance.js";
import { signalProxy, resolveSignal } from "./signal/proxy.js";

export { signalController, signalObserver, signalProxy, resolveSignal, signalInstance, signalSymb };
