//#region \0rolldown/runtime.js
var e = Object.create, t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, r = Object.getOwnPropertyNames, i = Object.getPrototypeOf, a = Object.prototype.hasOwnProperty, o = (e, t) => () => (t || (e((t = { exports: {} }).exports, t), e = null), t.exports), s = (e, n) => {
	let r = {};
	for (var i in e) t(r, i, {
		get: e[i],
		enumerable: !0
	});
	return n || t(r, Symbol.toStringTag, { value: "Module" }), r;
}, c = (e, i, o, s) => {
	if (i && typeof i == "object" || typeof i == "function") for (var c = r(i), l = 0, u = c.length, d; l < u; l++) d = c[l], !a.call(e, d) && d !== o && t(e, d, {
		get: ((e) => i[e]).bind(null, d),
		enumerable: !(s = n(i, d)) || s.enumerable
	});
	return e;
}, l = (n, r, o) => (o = n == null ? {} : e(i(n)), c(r || !n || !n.__esModule || !a.call(n, "default") ? t(o, "default", {
	value: n,
	enumerable: !0
}) : o, n)), u = /* @__PURE__ */ o(((e) => {
	var t = Symbol.for("react.transitional.element"), n = Symbol.for("react.portal"), r = Symbol.for("react.fragment"), i = Symbol.for("react.strict_mode"), a = Symbol.for("react.profiler"), o = Symbol.for("react.consumer"), s = Symbol.for("react.context"), c = Symbol.for("react.forward_ref"), l = Symbol.for("react.suspense"), u = Symbol.for("react.memo"), d = Symbol.for("react.lazy"), f = Symbol.for("react.activity"), p = Symbol.for("react.view_transition"), m = Symbol.iterator;
	function h(e) {
		return typeof e != "object" || !e ? null : (e = m && e[m] || e["@@iterator"], typeof e == "function" ? e : null);
	}
	var g = {
		isMounted: function() {
			return !1;
		},
		enqueueForceUpdate: function() {},
		enqueueReplaceState: function() {},
		enqueueSetState: function() {}
	}, _ = Object.assign, v = {};
	function y(e, t, n) {
		this.props = e, this.context = t, this.refs = v, this.updater = n || g;
	}
	y.prototype.isReactComponent = {}, y.prototype.setState = function(e, t) {
		if (typeof e != "object" && typeof e != "function" && e != null) throw Error("takes an object of state variables to update or a function which returns an object of state variables.");
		this.updater.enqueueSetState(this, e, t, "setState");
	}, y.prototype.forceUpdate = function(e) {
		this.updater.enqueueForceUpdate(this, e, "forceUpdate");
	};
	function b() {}
	b.prototype = y.prototype;
	function x(e, t, n) {
		this.props = e, this.context = t, this.refs = v, this.updater = n || g;
	}
	var S = x.prototype = new b();
	S.constructor = x, _(S, y.prototype), S.isPureReactComponent = !0;
	var C = Array.isArray;
	function w() {}
	var T = {
		H: null,
		A: null,
		T: null,
		S: null
	}, E = Object.prototype.hasOwnProperty;
	function D(e, n, r) {
		var i = r.ref;
		return {
			$$typeof: t,
			type: e,
			key: n,
			ref: i === void 0 ? null : i,
			props: r
		};
	}
	function O(e, t) {
		return D(e.type, t, e.props);
	}
	function k(e) {
		return typeof e == "object" && !!e && e.$$typeof === t;
	}
	function ee(e) {
		var t = {
			"=": "=0",
			":": "=2"
		};
		return "$" + e.replace(/[=:]/g, function(e) {
			return t[e];
		});
	}
	var A = /\/+/g;
	function te(e, t) {
		return typeof e == "object" && e && e.key != null ? ee("" + e.key) : t.toString(36);
	}
	function ne(e) {
		switch (e.status) {
			case "fulfilled": return e.value;
			case "rejected": throw e.reason;
			default: switch (typeof e.status == "string" ? e.then(w, w) : (e.status = "pending", e.then(function(t) {
				e.status === "pending" && (e.status = "fulfilled", e.value = t);
			}, function(t) {
				e.status === "pending" && (e.status = "rejected", e.reason = t);
			})), e.status) {
				case "fulfilled": return e.value;
				case "rejected": throw e.reason;
			}
		}
		throw e;
	}
	function j(e, r, i, a, o) {
		var s = typeof e;
		(s === "undefined" || s === "boolean") && (e = null);
		var c = !1;
		if (e === null) c = !0;
		else switch (s) {
			case "bigint":
			case "string":
			case "number":
				c = !0;
				break;
			case "object": switch (e.$$typeof) {
				case t:
				case n:
					c = !0;
					break;
				case d: return c = e._init, j(c(e._payload), r, i, a, o);
			}
		}
		if (c) return o = o(e), c = a === "" ? "." + te(e, 0) : a, C(o) ? (i = "", c != null && (i = c.replace(A, "$&/") + "/"), j(o, r, i, "", function(e) {
			return e;
		})) : o != null && (k(o) && (o = O(o, i + (o.key == null || e && e.key === o.key ? "" : ("" + o.key).replace(A, "$&/") + "/") + c)), r.push(o)), 1;
		c = 0;
		var l = a === "" ? "." : a + ":";
		if (C(e)) for (var u = 0; u < e.length; u++) a = e[u], s = l + te(a, u), c += j(a, r, i, s, o);
		else if (u = h(e), typeof u == "function") for (e = u.call(e), u = 0; !(a = e.next()).done;) a = a.value, s = l + te(a, u++), c += j(a, r, i, s, o);
		else if (s === "object") {
			if (typeof e.then == "function") return j(ne(e), r, i, a, o);
			throw r = String(e), Error("Objects are not valid as a React child (found: " + (r === "[object Object]" ? "object with keys {" + Object.keys(e).join(", ") + "}" : r) + "). If you meant to render a collection of children, use an array instead.");
		}
		return c;
	}
	function M(e, t, n) {
		if (e == null) return e;
		var r = [], i = 0;
		return j(e, r, "", "", function(e) {
			return t.call(n, e, i++);
		}), r;
	}
	function re(e) {
		if (e._status === -1) {
			var t = e._result, n = t();
			n.then(function(t) {
				(e._status === 0 || e._status === -1) && (e._status = 1, e._result = t, n.status === void 0 && (n.status = "fulfilled", n.value = t));
			}, function(t) {
				(e._status === 0 || e._status === -1) && (e._status = 2, e._result = t, n.status === void 0 && (n.status = "rejected", n.reason = t));
			}), e._status === -1 && (e._status = 0, e._result = n);
		}
		if (e._status === 1) return e._result.default;
		throw e._result;
	}
	var N = typeof reportError == "function" ? reportError : function(e) {
		if (typeof window == "object" && typeof window.ErrorEvent == "function") {
			var t = new window.ErrorEvent("error", {
				bubbles: !0,
				cancelable: !0,
				message: typeof e == "object" && e && typeof e.message == "string" ? String(e.message) : String(e),
				error: e
			});
			if (!window.dispatchEvent(t)) return;
		} else if (typeof process == "object" && typeof process.emit == "function") {
			process.emit("uncaughtException", e);
			return;
		}
		console.error(e);
	};
	function P(e) {
		var t = T.T, n = {};
		n.types = t === null ? null : t.types, T.T = n;
		try {
			var r = e(), i = T.S;
			i !== null && i(n, r), typeof r == "object" && r && typeof r.then == "function" && r.then(w, N);
		} catch (e) {
			N(e);
		} finally {
			t !== null && n.types !== null && (t.types = n.types), T.T = t;
		}
	}
	function ie(e) {
		var t = T.T;
		if (t !== null) {
			var n = t.types;
			n === null ? t.types = [e] : n.indexOf(e) === -1 && n.push(e);
		} else P(ie.bind(null, e));
	}
	var ae = {
		map: M,
		forEach: function(e, t, n) {
			M(e, function() {
				t.apply(this, arguments);
			}, n);
		},
		count: function(e) {
			var t = 0;
			return M(e, function() {
				t++;
			}), t;
		},
		toArray: function(e) {
			return M(e, function(e) {
				return e;
			}) || [];
		},
		only: function(e) {
			if (!k(e)) throw Error("React.Children.only expected to receive a single React element child.");
			return e;
		}
	};
	e.Activity = f, e.Children = ae, e.Component = y, e.Fragment = r, e.Profiler = a, e.PureComponent = x, e.StrictMode = i, e.Suspense = l, e.ViewTransition = p, e.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = T, e.__COMPILER_RUNTIME = {
		__proto__: null,
		c: function(e) {
			return T.H.useMemoCache(e);
		}
	}, e.addTransitionType = ie, e.cache = function(e) {
		return function() {
			return e.apply(null, arguments);
		};
	}, e.cacheSignal = function() {
		return null;
	}, e.cloneElement = function(e, t, n) {
		if (e == null) throw Error("The argument must be a React element, but you passed " + e + ".");
		var r = _({}, e.props), i = e.key;
		if (t != null) for (a in t.key !== void 0 && (i = "" + t.key), t) !E.call(t, a) || a === "key" || a === "__self" || a === "__source" || a === "ref" && t.ref === void 0 || (r[a] = t[a]);
		var a = arguments.length - 2;
		if (a === 1) r.children = n;
		else if (1 < a) {
			for (var o = Array(a), s = 0; s < a; s++) o[s] = arguments[s + 2];
			r.children = o;
		}
		return D(e.type, i, r);
	}, e.createContext = function(e) {
		return e = {
			$$typeof: s,
			_currentValue: e,
			_currentValue2: e,
			_threadCount: 0,
			Provider: null,
			Consumer: null
		}, e.Provider = e, e.Consumer = {
			$$typeof: o,
			_context: e
		}, e;
	}, e.createElement = function(e, t, n) {
		var r, i = {}, a = null;
		if (t != null) for (r in t.key !== void 0 && (a = "" + t.key), t) E.call(t, r) && r !== "key" && r !== "__self" && r !== "__source" && (i[r] = t[r]);
		var o = arguments.length - 2;
		if (o === 1) i.children = n;
		else if (1 < o) {
			for (var s = Array(o), c = 0; c < o; c++) s[c] = arguments[c + 2];
			i.children = s;
		}
		if (e && e.defaultProps) for (r in o = e.defaultProps, o) i[r] === void 0 && (i[r] = o[r]);
		return D(e, a, i);
	}, e.createRef = function() {
		return { current: null };
	}, e.forwardRef = function(e) {
		return {
			$$typeof: c,
			render: e
		};
	}, e.isValidElement = k, e.lazy = function(e) {
		return {
			$$typeof: d,
			_payload: {
				_status: -1,
				_result: e
			},
			_init: re
		};
	}, e.memo = function(e, t) {
		return {
			$$typeof: u,
			type: e,
			compare: t === void 0 ? null : t
		};
	}, e.startTransition = P, e.unstable_useCacheRefresh = function() {
		return T.H.useCacheRefresh();
	}, e.use = function(e) {
		return T.H.use(e);
	}, e.useActionState = function(e, t, n) {
		return T.H.useActionState(e, t, n);
	}, e.useCallback = function(e, t) {
		return T.H.useCallback(e, t);
	}, e.useContext = function(e) {
		return T.H.useContext(e);
	}, e.useDebugValue = function() {}, e.useDeferredValue = function(e, t) {
		return T.H.useDeferredValue(e, t);
	}, e.useEffect = function(e, t) {
		return T.H.useEffect(e, t);
	}, e.useEffectEvent = function(e) {
		return T.H.useEffectEvent(e);
	}, e.useId = function() {
		return T.H.useId();
	}, e.useImperativeHandle = function(e, t, n) {
		return T.H.useImperativeHandle(e, t, n);
	}, e.useInsertionEffect = function(e, t) {
		return T.H.useInsertionEffect(e, t);
	}, e.useLayoutEffect = function(e, t) {
		return T.H.useLayoutEffect(e, t);
	}, e.useMemo = function(e, t) {
		return T.H.useMemo(e, t);
	}, e.useOptimistic = function(e, t) {
		return T.H.useOptimistic(e, t);
	}, e.useReducer = function(e, t, n) {
		return T.H.useReducer(e, t, n);
	}, e.useRef = function(e) {
		return T.H.useRef(e);
	}, e.useState = function(e) {
		return T.H.useState(e);
	}, e.useSyncExternalStore = function(e, t, n) {
		return T.H.useSyncExternalStore(e, t, n);
	}, e.useTransition = function() {
		return T.H.useTransition();
	}, e.version = "19.3.0";
})), d = /* @__PURE__ */ o(((e, t) => {
	t.exports = u();
})), f = /* @__PURE__ */ o(((e) => {
	function t(e, t) {
		var n = e.length;
		e.push(t);
		a: for (; 0 < n;) {
			var r = n - 1 >>> 1, a = e[r];
			if (0 < i(a, t)) e[r] = t, e[n] = a, n = r;
			else break a;
		}
	}
	function n(e) {
		return e.length === 0 ? null : e[0];
	}
	function r(e) {
		if (e.length === 0) return null;
		var t = e[0], n = e.pop();
		if (n !== t) {
			e[0] = n;
			a: for (var r = 0, a = e.length, o = a >>> 1; r < o;) {
				var s = 2 * (r + 1) - 1, c = e[s], l = s + 1, u = e[l];
				if (0 > i(c, n)) l < a && 0 > i(u, c) ? (e[r] = u, e[l] = n, r = l) : (e[r] = c, e[s] = n, r = s);
				else if (l < a && 0 > i(u, n)) e[r] = u, e[l] = n, r = l;
				else break a;
			}
		}
		return t;
	}
	function i(e, t) {
		var n = e.sortIndex - t.sortIndex;
		return n === 0 ? e.id - t.id : n;
	}
	if (e.unstable_now = void 0, typeof performance == "object" && typeof performance.now == "function") {
		var a = performance;
		e.unstable_now = function() {
			return a.now();
		};
	} else {
		var o = Date, s = o.now();
		e.unstable_now = function() {
			return o.now() - s;
		};
	}
	var c = [], l = [], u = 1, d = null, f = 3, p = !1, m = !1, h = !1, g = !1, _ = typeof setTimeout == "function" ? setTimeout : null, v = typeof clearTimeout == "function" ? clearTimeout : null, y = typeof setImmediate < "u" ? setImmediate : null;
	function b(e) {
		for (var i = n(l); i !== null;) {
			if (i.callback === null) r(l);
			else if (i.startTime <= e) r(l), i.sortIndex = i.expirationTime, t(c, i);
			else break;
			i = n(l);
		}
	}
	function x(e) {
		if (h = !1, b(e), !m) {
			if (n(c) !== null) m = !0, S || (S = !0, O());
			else {
				var t = n(l);
				t !== null && A(x, t.startTime - e);
			}
		}
	}
	var S = !1, C = -1, w = 5, T = -1;
	function E() {
		return g ? !0 : !(e.unstable_now() - T < w);
	}
	function D() {
		if (g = !1, S) {
			var t = e.unstable_now();
			T = t;
			var i = !0;
			try {
				a: {
					m = !1, h && (h = !1, v(C), C = -1), p = !0;
					var a = f;
					try {
						b: {
							for (b(t), d = n(c); d !== null && !(d.expirationTime > t && E());) {
								var o = d.callback;
								if (typeof o == "function") {
									d.callback = null, f = d.priorityLevel;
									var s = o(d.expirationTime <= t);
									if (t = e.unstable_now(), typeof s == "function") {
										d.callback = s, b(t), i = !0;
										break b;
									}
									d === n(c) && r(c), b(t);
								} else r(c);
								d = n(c);
							}
							if (d !== null) i = !0;
							else {
								var u = n(l);
								u !== null && A(x, u.startTime - t), i = !1;
							}
						}
						break a;
					} finally {
						d = null, f = a, p = !1;
					}
					i = void 0;
				}
			} finally {
				i ? O() : S = !1;
			}
		}
	}
	var O;
	if (typeof y == "function") O = function() {
		y(D);
	};
	else if (typeof MessageChannel < "u") {
		var k = new MessageChannel(), ee = k.port2;
		k.port1.onmessage = D, O = function() {
			ee.postMessage(null);
		};
	} else O = function() {
		_(D, 0);
	};
	function A(t, n) {
		C = _(function() {
			t(e.unstable_now());
		}, n);
	}
	e.unstable_IdlePriority = 5, e.unstable_ImmediatePriority = 1, e.unstable_LowPriority = 4, e.unstable_NormalPriority = 3, e.unstable_Profiling = null, e.unstable_UserBlockingPriority = 2, e.unstable_cancelCallback = function(e) {
		e.callback = null;
	}, e.unstable_forceFrameRate = function(e) {
		0 > e || 125 < e ? console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported") : w = 0 < e ? Math.floor(1e3 / e) : 5;
	}, e.unstable_getCurrentPriorityLevel = function() {
		return f;
	}, e.unstable_next = function(e) {
		switch (f) {
			case 1:
			case 2:
			case 3:
				var t = 3;
				break;
			default: t = f;
		}
		var n = f;
		f = t;
		try {
			return e();
		} finally {
			f = n;
		}
	}, e.unstable_requestPaint = function() {
		g = !0;
	}, e.unstable_runWithPriority = function(e, t) {
		switch (e) {
			case 1:
			case 2:
			case 3:
			case 4:
			case 5: break;
			default: e = 3;
		}
		var n = f;
		f = e;
		try {
			return t();
		} finally {
			f = n;
		}
	}, e.unstable_scheduleCallback = function(r, i, a) {
		var o = e.unstable_now();
		switch (typeof a == "object" && a ? (a = a.delay, a = typeof a == "number" && 0 < a ? o + a : o) : a = o, r) {
			case 1:
				var s = -1;
				break;
			case 2:
				s = 250;
				break;
			case 5:
				s = 1073741823;
				break;
			case 4:
				s = 1e4;
				break;
			default: s = 5e3;
		}
		return s = a + s, r = {
			id: u++,
			callback: i,
			priorityLevel: r,
			startTime: a,
			expirationTime: s,
			sortIndex: -1
		}, a > o ? (r.sortIndex = a, t(l, r), n(c) === null && r === n(l) && (h ? (v(C), C = -1) : h = !0, A(x, a - o))) : (r.sortIndex = s, t(c, r), m || p || (m = !0, S || (S = !0, O()))), r;
	}, e.unstable_shouldYield = E, e.unstable_wrapCallback = function(e) {
		var t = f;
		return function() {
			var n = f;
			f = t;
			try {
				return e.apply(this, arguments);
			} finally {
				f = n;
			}
		};
	};
})), p = /* @__PURE__ */ o(((e, t) => {
	t.exports = f();
})), m = /* @__PURE__ */ o(((e) => {
	var t = d();
	function n(e) {
		var t = "https://react.dev/errors/" + e;
		if (1 < arguments.length) {
			t += "?args[]=" + encodeURIComponent(arguments[1]);
			for (var n = 2; n < arguments.length; n++) t += "&args[]=" + encodeURIComponent(arguments[n]);
		}
		return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
	}
	function r() {}
	var i = {
		d: {
			f: r,
			r: function() {
				throw Error(n(522));
			},
			D: r,
			C: r,
			L: r,
			m: r,
			X: r,
			S: r,
			M: r
		},
		p: 0,
		findDOMNode: null
	}, a = Symbol.for("react.portal"), o = Symbol.for("react.recoverable"), s = Symbol.for("react.optimistic_key");
	function c(e, t, n) {
		var r = 3 < arguments.length && arguments[3] !== void 0 ? arguments[3] : null;
		return {
			$$typeof: a,
			key: r == null ? null : r === s ? s : "" + r,
			children: e,
			containerInfo: t,
			implementation: n
		};
	}
	var l = t.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	function u(e, t) {
		if (e === "font") return "";
		if (typeof t == "string") return t === "use-credentials" ? t : "";
	}
	e.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = i, e.browser = function(e) {
		return {
			$$typeof: o,
			_reason: e
		};
	}, e.createPortal = function(e, t) {
		var r = 2 < arguments.length && arguments[2] !== void 0 ? arguments[2] : null;
		if (!t || t.nodeType !== 1 && t.nodeType !== 9 && t.nodeType !== 11) throw Error(n(299));
		return c(e, t, null, r);
	}, e.flushSync = function(e) {
		var t = l.T, n = i.p;
		try {
			if (l.T = null, i.p = 2, e) return e();
		} finally {
			l.T = t, i.p = n, i.d.f();
		}
	}, e.preconnect = function(e, t) {
		typeof e == "string" && (t ? (t = t.crossOrigin, t = typeof t == "string" ? t === "use-credentials" ? t : "" : void 0) : t = null, i.d.C(e, t));
	}, e.prefetchDNS = function(e) {
		typeof e == "string" && i.d.D(e);
	}, e.preinit = function(e, t) {
		if (typeof e == "string" && t && typeof t.as == "string") {
			var n = t.as, r = u(n, t.crossOrigin), a = typeof t.integrity == "string" ? t.integrity : void 0, o = typeof t.fetchPriority == "string" ? t.fetchPriority : void 0;
			n === "style" ? i.d.S(e, typeof t.precedence == "string" ? t.precedence : void 0, {
				crossOrigin: r,
				integrity: a,
				fetchPriority: o
			}) : n === "script" && i.d.X(e, {
				crossOrigin: r,
				integrity: a,
				fetchPriority: o,
				nonce: typeof t.nonce == "string" ? t.nonce : void 0
			});
		}
	}, e.preinitModule = function(e, t) {
		if (typeof e == "string") {
			if (typeof t == "object" && t) {
				if (t.as == null || t.as === "script") {
					var n = u(t.as, t.crossOrigin);
					i.d.M(e, {
						crossOrigin: n,
						integrity: typeof t.integrity == "string" ? t.integrity : void 0,
						nonce: typeof t.nonce == "string" ? t.nonce : void 0,
						fetchPriority: typeof t.fetchPriority == "string" ? t.fetchPriority : void 0
					});
				}
			} else t ?? i.d.M(e);
		}
	}, e.preload = function(e, t) {
		if (typeof e == "string" && typeof t == "object" && t && typeof t.as == "string") {
			var n = t.as, r = u(n, t.crossOrigin);
			i.d.L(e, n, {
				crossOrigin: r,
				integrity: typeof t.integrity == "string" ? t.integrity : void 0,
				nonce: typeof t.nonce == "string" ? t.nonce : void 0,
				type: typeof t.type == "string" ? t.type : void 0,
				fetchPriority: typeof t.fetchPriority == "string" ? t.fetchPriority : void 0,
				referrerPolicy: typeof t.referrerPolicy == "string" ? t.referrerPolicy : void 0,
				imageSrcSet: typeof t.imageSrcSet == "string" ? t.imageSrcSet : void 0,
				imageSizes: typeof t.imageSizes == "string" ? t.imageSizes : void 0,
				media: typeof t.media == "string" ? t.media : void 0
			});
		}
	}, e.preloadModule = function(e, t) {
		if (typeof e == "string") {
			if (t) {
				var n = u(t.as, t.crossOrigin);
				i.d.m(e, {
					as: typeof t.as == "string" && t.as !== "script" ? t.as : void 0,
					crossOrigin: n,
					integrity: typeof t.integrity == "string" ? t.integrity : void 0,
					nonce: typeof t.nonce == "string" ? t.nonce : void 0,
					fetchPriority: typeof t.fetchPriority == "string" ? t.fetchPriority : void 0
				});
			} else i.d.m(e);
		}
	}, e.requestFormReset = function(e) {
		i.d.r(e);
	}, e.unstable_batchedUpdates = function(e, t) {
		return e(t);
	}, e.useFormState = function(e, t, n) {
		return l.H.useFormState(e, t, n);
	}, e.useFormStatus = function() {
		return l.H.useHostTransitionStatus();
	}, e.version = "19.3.0";
})), h = /* @__PURE__ */ o(((e, t) => {
	function n() {
		if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE == "function") try {
			__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
		} catch (e) {
			console.error(e);
		}
	}
	n(), t.exports = m();
})), g = /* @__PURE__ */ o(((e) => {
	var t = p(), n = d(), r = h();
	function i(e) {
		var t = "https://react.dev/errors/" + e;
		if (1 < arguments.length) {
			t += "?args[]=" + encodeURIComponent(arguments[1]);
			for (var n = 2; n < arguments.length; n++) t += "&args[]=" + encodeURIComponent(arguments[n]);
		}
		return "Minified React error #" + e + "; visit " + t + " for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
	}
	function a(e) {
		return !(!e || e.nodeType !== 1 && e.nodeType !== 9 && e.nodeType !== 11);
	}
	function o(e) {
		for (var t = e, n = t; n && !n.alternate;) t = n, t.flags & 4098 && (e = t.return), n = t.return;
		for (; t.return;) t = t.return;
		return t.tag === 3 ? e : null;
	}
	function s(e) {
		if (e.tag === 13) {
			var t = e.memoizedState;
			if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
		}
		return null;
	}
	function c(e) {
		if (e.tag === 31) {
			var t = e.memoizedState;
			if (t === null && (e = e.alternate, e !== null && (t = e.memoizedState)), t !== null) return t.dehydrated;
		}
		return null;
	}
	function l(e) {
		if (o(e) !== e) throw Error(i(188));
	}
	function u(e) {
		var t = e.alternate;
		if (!t) {
			if (t = o(e), t === null) throw Error(i(188));
			return t === e ? e : null;
		}
		for (var n = e, r = t;;) {
			var a = n.return;
			if (a === null) break;
			var s = a.alternate;
			if (s === null) {
				if (r = a.return, r !== null) {
					n = r;
					continue;
				}
				break;
			}
			if (a.child === s.child) {
				for (s = a.child; s;) {
					if (s === n) return l(a), e;
					if (s === r) return l(a), t;
					s = s.sibling;
				}
				throw Error(i(188));
			}
			if (n.return !== r.return) n = a, r = s;
			else {
				for (var c = !1, u = a.child; u;) {
					if (u === n) {
						c = !0, n = a, r = s;
						break;
					}
					if (u === r) {
						c = !0, r = a, n = s;
						break;
					}
					u = u.sibling;
				}
				if (!c) {
					for (u = s.child; u;) {
						if (u === n) {
							c = !0, n = s, r = a;
							break;
						}
						if (u === r) {
							c = !0, r = s, n = a;
							break;
						}
						u = u.sibling;
					}
					if (!c) throw Error(i(189));
				}
			}
			if (n.alternate !== r) throw Error(i(190));
		}
		if (n.tag !== 3) throw Error(i(188));
		return n.stateNode.current === n ? e : t;
	}
	function f(e) {
		var t = e.tag;
		if (t === 5 || t === 26 || t === 27 || t === 6) return e;
		for (e = e.child; e !== null;) {
			if (t = f(e), t !== null) return t;
			e = e.sibling;
		}
		return null;
	}
	function m(e, t, n, r, i, a) {
		for (; e !== null;) {
			if ((e.tag === 5 || e.tag === 27 || e.tag === 6) && n(e, r, i, a) || (e.tag !== 22 || e.memoizedState === null) && (t || e.tag !== 5 && e.tag !== 27) && m(e.child, t, n, r, i, a)) return !0;
			e = e.sibling;
		}
		return !1;
	}
	function g(e) {
		for (e = e.return; e !== null;) {
			if (e.tag === 3 || e.tag === 5 || e.tag === 27) return e;
			e = e.return;
		}
		return null;
	}
	function _(e) {
		var t = !1;
		for (e = e.return; e !== null && (e.tag === 4 && (t = !0), e.tag !== 3 && e.tag !== 5 && e.tag !== 27);) e = e.return;
		return t;
	}
	function v(e) {
		var t = [null, null], n = g(e);
		return n === null || y(t, e, n.child, { foundSelf: !1 }), t;
	}
	function y(e, t, n, r) {
		for (; n !== null;) {
			if (n === t) r.foundSelf = !0;
			else if (n.tag === 5 || n.tag === 27 || n.tag === 6) {
				if (r.foundSelf) return e[1] = n, !0;
				e[0] = n;
			} else if ((n.tag !== 22 || n.memoizedState === null) && y(e, t, n.child, r)) return !0;
			n = n.sibling;
		}
		return !1;
	}
	function b(e) {
		switch (e.tag) {
			case 5:
			case 27:
			case 6: return e.stateNode;
			case 3: return e.stateNode.containerInfo;
			default: throw Error(i(559));
		}
	}
	var x = null, S = null;
	function C(e, t, n) {
		return e === n || e === t && (x = e, !0);
	}
	function w(e, t, n) {
		return e === n ? (S = e, !1) : e === t && (S !== null && (x = e), !0);
	}
	function T(e) {
		if (e === null) return null;
		do
			e = e === null ? null : e.return;
		while (e && e.tag !== 5 && e.tag !== 27 && e.tag !== 3);
		return e || null;
	}
	function E(e, t, n) {
		for (var r = 0, i = e; i; i = n(i)) r++;
		i = 0;
		for (var a = t; a; a = n(a)) i++;
		for (; 0 < r - i;) e = n(e), r--;
		for (; 0 < i - r;) t = n(t), i--;
		for (; r--;) {
			if (e === t || t !== null && e === t.alternate) return e;
			e = n(e), t = n(t);
		}
		return null;
	}
	var D = Object.assign, O = Symbol.for("react.element"), k = Symbol.for("react.transitional.element"), ee = Symbol.for("react.portal"), A = Symbol.for("react.fragment"), te = Symbol.for("react.strict_mode"), ne = Symbol.for("react.profiler"), j = Symbol.for("react.consumer"), M = Symbol.for("react.context"), re = Symbol.for("react.forward_ref"), N = Symbol.for("react.suspense"), P = Symbol.for("react.suspense_list"), ie = Symbol.for("react.memo"), ae = Symbol.for("react.lazy"), oe = Symbol.for("react.activity"), se = Symbol.for("react.legacy_hidden"), ce = Symbol.for("react.memo_cache_sentinel"), le = Symbol.for("react.view_transition"), ue = Symbol.for("react.recoverable"), de = Symbol.iterator;
	function fe(e) {
		return typeof e != "object" || !e ? null : (e = de && e[de] || e["@@iterator"], typeof e == "function" ? e : null);
	}
	var pe = Symbol.for("react.client.reference");
	function me(e) {
		if (e == null) return null;
		if (typeof e == "function") return e.$$typeof === pe ? null : e.displayName || e.name || null;
		if (typeof e == "string") return e;
		switch (e) {
			case A: return "Fragment";
			case ne: return "Profiler";
			case te: return "StrictMode";
			case N: return "Suspense";
			case P: return "SuspenseList";
			case oe: return "Activity";
			case le: return "ViewTransition";
		}
		if (typeof e == "object") switch (e.$$typeof) {
			case ee: return "Portal";
			case M: return e.displayName || "Context";
			case j: return (e._context.displayName || "Context") + ".Consumer";
			case re:
				var t = e.render;
				return e = e.displayName, e ||= (e = t.displayName || t.name || "", e === "" ? "ForwardRef" : "ForwardRef(" + e + ")"), e;
			case ie: return t = e.displayName || null, t === null ? me(e.type) || "Memo" : t;
			case ae:
				t = e._payload, e = e._init;
				try {
					return me(e(t));
				} catch {}
		}
		return null;
	}
	var he = Array.isArray, F = n.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, I = r.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, ge = {
		pending: !1,
		data: null,
		method: null,
		action: null
	}, _e = [], ve = -1;
	function ye(e) {
		return { current: e };
	}
	function be(e) {
		0 > ve || (e.current = _e[ve], _e[ve] = null, ve--);
	}
	function xe(e, t) {
		ve++, _e[ve] = e.current, e.current = t;
	}
	var Se = ye(null), Ce = ye(null), we = ye(null), Te = ye(null);
	function Ee(e, t) {
		switch (xe(we, t), xe(Ce, e), xe(Se, null), t.nodeType) {
			case 9:
			case 11:
				e = (e = t.documentElement) && (e = e.namespaceURI) ? hp(e) : 0;
				break;
			default: if (e = t.tagName, t = t.namespaceURI) t = hp(t), e = gp(t, e);
			else switch (e) {
				case "svg":
					e = 1;
					break;
				case "math":
					e = 2;
					break;
				default: e = 0;
			}
		}
		be(Se), xe(Se, e);
	}
	function De() {
		be(Se), be(Ce), be(we);
	}
	function Oe(e) {
		var t = e.memoizedState;
		t !== null && (uh._currentValue = t.memoizedState, xe(Te, e)), t = Se.current;
		var n = gp(t, e.type);
		t !== n && (xe(Ce, e), xe(Se, n));
	}
	function ke(e) {
		Ce.current === e && (be(Se), be(Ce)), Te.current === e && (be(Te), uh._currentValue = ge);
	}
	var Ae, je;
	function Me(e) {
		if (Ae === void 0) try {
			throw Error();
		} catch (e) {
			var t = e.stack.trim().match(/\n( *(at )?)/);
			Ae = t && t[1] || "", je = -1 < e.stack.indexOf("\n    at") ? " (<anonymous>)" : -1 < e.stack.indexOf("@") ? "@unknown:0:0" : "";
		}
		return "\n" + Ae + e + je;
	}
	var Ne = !1;
	function Pe(e, t) {
		if (!e || Ne) return "";
		Ne = !0;
		var n = Error.prepareStackTrace;
		Error.prepareStackTrace = void 0;
		try {
			var r = { DetermineComponentFrameRoot: function() {
				try {
					if (t) {
						var n = function() {
							throw Error();
						};
						if (Object.defineProperty(n.prototype, "props", { set: function() {
							throw Error();
						} }), typeof Reflect == "object" && Reflect.construct) {
							try {
								Reflect.construct(n, []);
							} catch (e) {
								var r = e;
							}
							Reflect.construct(e, [], n);
						} else {
							try {
								n.call();
							} catch (e) {
								r = e;
							}
							n = !1;
							try {
								var i = Object.getOwnPropertyDescriptor(e.prototype, "props");
								Object.defineProperty(e.prototype, "props", {
									configurable: !0,
									set: function() {
										throw Error();
									}
								}), n = !0, new e();
							} finally {
								n && (i === void 0 ? delete e.prototype.props : Object.defineProperty(e.prototype, "props", i));
							}
						}
					} else {
						try {
							throw Error();
						} catch (e) {
							r = e;
						}
						(n = e()) && typeof n.catch == "function" && n.catch(function() {});
					}
				} catch (e) {
					if (e && r && typeof e.stack == "string") return [e.stack, r.stack];
				}
				return [null, null];
			} };
			r.DetermineComponentFrameRoot.displayName = "DetermineComponentFrameRoot";
			var i = Object.getOwnPropertyDescriptor(r.DetermineComponentFrameRoot, "name");
			i && i.configurable && Object.defineProperty(r.DetermineComponentFrameRoot, "name", { value: "DetermineComponentFrameRoot" });
			var a = r.DetermineComponentFrameRoot(), o = a[0], s = a[1];
			if (o && s) {
				var c = o.split("\n"), l = s.split("\n");
				for (i = r = 0; r < c.length && !c[r].includes("DetermineComponentFrameRoot");) r++;
				for (; i < l.length && !l[i].includes("DetermineComponentFrameRoot");) i++;
				if (r === c.length || i === l.length) for (r = c.length - 1, i = l.length - 1; 1 <= r && 0 <= i && c[r] !== l[i];) i--;
				for (; 1 <= r && 0 <= i; r--, i--) if (c[r] !== l[i]) {
					if (r !== 1 || i !== 1) do
						if (r--, i--, 0 > i || c[r] !== l[i]) {
							var u = "\n" + c[r].replace(" at new ", " at ");
							return e.displayName && u.includes("<anonymous>") && (u = u.replace("<anonymous>", e.displayName)), u;
						}
					while (1 <= r && 0 <= i);
					break;
				}
			}
		} finally {
			Ne = !1, Error.prepareStackTrace = n;
		}
		return (n = e ? e.displayName || e.name : "") ? Me(n) : "";
	}
	function Fe(e, t) {
		switch (e.tag) {
			case 26:
			case 27:
			case 5: return Me(e.type);
			case 16: return Me("Lazy");
			case 13: return e.child !== t && t !== null ? Me("Suspense Fallback") : Me("Suspense");
			case 19: return Me("SuspenseList");
			case 0:
			case 15: return Pe(e.type, !1);
			case 11: return Pe(e.type.render, !1);
			case 1: return Pe(e.type, !0);
			case 31: return Me("Activity");
			case 30: return Me("ViewTransition");
			default: return "";
		}
	}
	function Ie(e) {
		try {
			var t = "", n = null;
			do
				t += Fe(e, n), n = e, e = e.return;
			while (e);
			return t;
		} catch (e) {
			return "\nError generating stack: " + e.message + "\n" + e.stack;
		}
	}
	var Le = Object.prototype.hasOwnProperty, Re = t.unstable_scheduleCallback, ze = t.unstable_cancelCallback, Be = t.unstable_shouldYield, Ve = t.unstable_requestPaint, He = t.unstable_now, Ue = t.unstable_getCurrentPriorityLevel, We = t.unstable_ImmediatePriority, Ge = t.unstable_UserBlockingPriority, Ke = t.unstable_NormalPriority, qe = t.unstable_LowPriority, Je = t.unstable_IdlePriority, Ye = t.log, Xe = t.unstable_setDisableYieldValue, Ze = null, L = null;
	function Qe(e) {
		if (typeof Ye == "function" && Xe(e), L && typeof L.setStrictMode == "function") try {
			L.setStrictMode(Ze, e);
		} catch {}
	}
	var $e = Math.clz32 ? Math.clz32 : nt, et = Math.log, tt = Math.LN2;
	function nt(e) {
		return e >>>= 0, e === 0 ? 32 : 31 - (et(e) / tt | 0) | 0;
	}
	var R = 256, rt = 262144, it = 4194304;
	function at(e) {
		var t = e & 42;
		if (t !== 0) return t;
		switch (e & -e) {
			case 1: return 1;
			case 2: return 2;
			case 4: return 4;
			case 8: return 8;
			case 16: return 16;
			case 32: return 32;
			case 64: return 64;
			case 128: return 128;
			case 256:
			case 512:
			case 1024:
			case 2048:
			case 4096:
			case 8192:
			case 16384:
			case 32768:
			case 65536:
			case 131072: return e & -e;
			case 262144:
			case 524288:
			case 1048576:
			case 2097152: return e & 3932160;
			case 4194304:
			case 8388608:
			case 16777216:
			case 33554432: return e & 62914560;
			case 67108864: return 67108864;
			case 134217728: return 134217728;
			case 268435456: return 268435456;
			case 536870912: return 536870912;
			case 1073741824: return 0;
			default: return e;
		}
	}
	function ot(e, t, n) {
		var r = e.pendingLanes;
		if (r === 0) return 0;
		var i = 0, a = e.suspendedLanes, o = e.pingedLanes;
		e = e.warmLanes;
		var s = r & 134217727;
		return s === 0 ? (s = r & ~a, s === 0 ? o === 0 ? n || (n = r & ~e, n !== 0 && (i = at(n))) : i = at(o) : i = at(s)) : (r = s & ~a, r === 0 ? (o &= s, o === 0 ? n || (n = s & ~e, n !== 0 && (i = at(n))) : i = at(o)) : i = at(r)), i === 0 ? 0 : t !== 0 && t !== i && (t & a) === 0 && (a = i & -i, n = t & -t, a >= n || a === 32 && n & 4194048) ? t : i;
	}
	function st(e, t) {
		return (e.pendingLanes & ~(e.suspendedLanes & ~e.pingedLanes) & t) === 0;
	}
	function ct(e, t) {
		t & 8 && (t |= t & 32);
		var n = e.entangledLanes;
		if (n !== 0) for (e = e.entanglements, n &= t; 0 < n;) {
			var r = 31 - $e(n), i = 1 << r;
			t |= e[r], n &= ~i;
		}
		return t;
	}
	function lt(e, t) {
		switch (e) {
			case 1:
			case 2:
			case 4:
			case 8:
			case 64: return t + 250;
			case 16:
			case 32:
			case 128:
			case 256:
			case 512:
			case 1024:
			case 2048:
			case 4096:
			case 8192:
			case 16384:
			case 32768:
			case 65536:
			case 131072:
			case 262144:
			case 524288:
			case 1048576:
			case 2097152: return t + 5e3;
			case 4194304:
			case 8388608:
			case 16777216:
			case 33554432: return -1;
			case 67108864:
			case 134217728:
			case 268435456:
			case 536870912:
			case 1073741824: return -1;
			default: return -1;
		}
	}
	function ut() {
		var e = it;
		return it <<= 1, !(it & 62914560) && (it = 4194304), e;
	}
	function dt(e) {
		for (var t = [], n = 0; 31 > n; n++) t.push(e);
		return t;
	}
	function ft(e, t) {
		e.pendingLanes |= t, t !== 268435456 && (e.suspendedLanes = 0, e.pingedLanes = 0, e.warmLanes = 0);
	}
	function pt(e, t, n, r, i, a) {
		var o = e.pendingLanes;
		e.pendingLanes = n, e.suspendedLanes = 0, e.pingedLanes = 0, e.warmLanes = 0, e.expiredLanes &= n, e.entangledLanes &= n, e.errorRecoveryDisabledLanes &= n, e.shellSuspendCounter = 0;
		var s = e.entanglements, c = e.expirationTimes, l = e.hiddenUpdates;
		for (n = o & ~n; 0 < n;) {
			var u = 31 - $e(n), d = 1 << u;
			s[u] = 0, c[u] = -1;
			var f = l[u];
			if (f !== null) for (l[u] = null, u = 0; u < f.length; u++) {
				var p = f[u];
				p !== null && (p.lane &= -536870913);
			}
			n &= ~d;
		}
		r !== 0 && mt(e, r, 0), a !== 0 && i === 0 && e.tag !== 0 && (e.suspendedLanes |= a & ~(o & ~t));
	}
	function mt(e, t, n) {
		e.pendingLanes |= t, e.suspendedLanes &= ~t;
		var r = 31 - $e(t);
		e.entangledLanes |= t, e.entanglements[r] = e.entanglements[r] | 1073741824 | n & 261930;
	}
	function ht(e, t) {
		var n = e.entangledLanes |= t;
		for (e = e.entanglements; n;) {
			var r = 31 - $e(n), i = 1 << r;
			i & t | e[r] & t && (e[r] |= t), n &= ~i;
		}
	}
	function gt(e, t) {
		var n = t & -t;
		return n = n & 42 ? 1 : _t(n), (n & (e.suspendedLanes | t)) === 0 ? n : 0;
	}
	function _t(e) {
		switch (e) {
			case 2:
				e = 1;
				break;
			case 8:
				e = 4;
				break;
			case 32:
				e = 16;
				break;
			case 256:
			case 512:
			case 1024:
			case 2048:
			case 4096:
			case 8192:
			case 16384:
			case 32768:
			case 65536:
			case 131072:
			case 262144:
			case 524288:
			case 1048576:
			case 2097152:
			case 4194304:
			case 8388608:
			case 16777216:
			case 33554432:
				e = 128;
				break;
			case 268435456:
				e = 134217728;
				break;
			default: e = 0;
		}
		return e;
	}
	function vt(e) {
		return e &= -e, 2 < e ? 8 < e ? e & 134217727 ? 32 : 268435456 : 8 : 2;
	}
	function yt() {
		var e = I.p;
		return e === 0 ? (e = window.event, e === void 0 ? 32 : Eh(e.type)) : e;
	}
	function bt(e, t) {
		var n = I.p;
		try {
			return I.p = e, t();
		} finally {
			I.p = n;
		}
	}
	var xt = Math.random().toString(36).slice(2), St = "__reactFiber$" + xt, Ct = "__reactProps$" + xt, wt = "__reactContainer$" + xt, Tt = "__reactEvents$" + xt, Et = "__reactListeners$" + xt, Dt = "__reactHandles$" + xt, Ot = "__reactResources$" + xt, kt = "__reactMarker$" + xt, At = "__reactLoad$" + xt;
	function jt(e) {
		delete e[St], delete e[Ct], delete e[Et], delete e[Dt];
	}
	function Mt(e) {
		var t;
		if (t = e[St]) return t;
		for (var n = e.parentNode; n;) {
			if (t = n[wt] || n[St]) {
				if (n = t.alternate, t.child !== null || n !== null && n.child !== null) for (e = _m(e); e !== null;) {
					if (n = e[St]) return n;
					e = _m(e);
				}
				return t;
			}
			e = n, n = e.parentNode;
		}
		return null;
	}
	function Nt(e) {
		if (e = e[St] || e[wt]) {
			var t = e.tag;
			if (t === 5 || t === 6 || t === 13 || t === 31 || t === 26 || t === 27 || t === 3) return e;
		}
		return null;
	}
	function Pt(e) {
		var t = e.tag;
		if (t === 5 || t === 26 || t === 27 || t === 6) return e.stateNode;
		throw Error(i(33));
	}
	function Ft(e) {
		var t = e[Ot];
		return t ||= e[Ot] = {
			hoistableStyles: /* @__PURE__ */ new Map(),
			hoistableScripts: /* @__PURE__ */ new Map()
		}, t;
	}
	function It(e) {
		e[kt] = !0;
	}
	function Lt(e) {
		e[At] = void 0;
	}
	var Rt = /* @__PURE__ */ new Set(), zt = {};
	function Bt(e, t) {
		Vt(e, t), Vt(e + "Capture", t);
	}
	function Vt(e, t) {
		for (zt[e] = t, e = 0; e < t.length; e++) Rt.add(t[e]);
	}
	var Ht = RegExp("^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"), Ut = {}, Wt = {};
	function Gt(e) {
		return Le.call(Wt, e) ? !0 : Le.call(Ut, e) ? !1 : Ht.test(e) ? Wt[e] = !0 : (Ut[e] = !0, !1);
	}
	var z = !1;
	function Kt() {
		var e = z;
		return z = !1, e;
	}
	function qt(e, t, n) {
		if (Gt(t)) {
			if (n === null) e.removeAttribute(t);
			else {
				switch (typeof n) {
					case "undefined":
					case "function":
					case "symbol":
						e.removeAttribute(t);
						return;
					case "boolean":
						var r = t.toLowerCase().slice(0, 5);
						if (r !== "data-" && r !== "aria-") {
							e.removeAttribute(t);
							return;
						}
				}
				e.setAttribute(t, n);
			}
		}
	}
	function Jt(e, t, n) {
		if (n === null) e.removeAttribute(t);
		else {
			switch (typeof n) {
				case "undefined":
				case "function":
				case "symbol":
				case "boolean":
					e.removeAttribute(t);
					return;
			}
			e.setAttribute(t, n);
		}
	}
	function Yt(e, t, n, r) {
		if (r === null) e.removeAttribute(n);
		else {
			switch (typeof r) {
				case "undefined":
				case "function":
				case "symbol":
				case "boolean":
					e.removeAttribute(n);
					return;
			}
			e.setAttributeNS(t, n, r);
		}
	}
	function Xt(e) {
		switch (typeof e) {
			case "bigint":
			case "boolean":
			case "number":
			case "string":
			case "undefined": return e;
			case "object": return e;
			default: return "";
		}
	}
	function Zt(e) {
		var t = e.type;
		return (e = e.nodeName) && e.toLowerCase() === "input" && (t === "checkbox" || t === "radio");
	}
	function Qt(e, t, n) {
		var r = Object.getOwnPropertyDescriptor(e.constructor.prototype, t);
		if (!e.hasOwnProperty(t) && r !== void 0 && typeof r.get == "function" && typeof r.set == "function") {
			var i = r.get, a = r.set;
			return Object.defineProperty(e, t, {
				configurable: !0,
				get: function() {
					return i.call(this);
				},
				set: function(e) {
					n = "" + e, a.call(this, e);
				}
			}), Object.defineProperty(e, t, { enumerable: r.enumerable }), {
				getValue: function() {
					return n;
				},
				setValue: function(e) {
					n = "" + e;
				},
				stopTracking: function() {
					e._valueTracker = null, delete e[t];
				}
			};
		}
	}
	function $t(e) {
		if (!e._valueTracker) {
			var t = Zt(e) ? "checked" : "value";
			e._valueTracker = Qt(e, t, "" + e[t]);
		}
	}
	function en(e) {
		if (!e) return !1;
		var t = e._valueTracker;
		if (!t) return !0;
		var n = t.getValue(), r = "";
		return e && (r = Zt(e) ? e.checked ? "true" : "false" : e.value), e = r, e !== n && (t.setValue(e), !0);
	}
	var tn = /[\n"\\]/g;
	function nn(e) {
		return e.replace(tn, function(e) {
			return "\\" + e.charCodeAt(0).toString(16) + " ";
		});
	}
	function rn(e, t, n, r, i, a, o, s) {
		e.name = "", o != null && typeof o != "function" && typeof o != "symbol" && typeof o != "boolean" ? e.type = o : e.removeAttribute("type"), t == null ? o !== "submit" && o !== "reset" || e.removeAttribute("value") : o === "number" ? (t === 0 && e.value === "" || e.value != t) && (e.value = "" + Xt(t)) : e.value !== "" + Xt(t) && (e.value = "" + Xt(t)), t == null ? n == null ? r != null && e.removeAttribute("value") : on(e, Xt(n)) : o === "number" && e.value == t ? on(e, Xt(e.value)) : on(e, Xt(t)), i == null && a != null && (e.defaultChecked = !!a), i != null && (e.checked = i && typeof i != "function" && typeof i != "symbol"), s != null && typeof s != "function" && typeof s != "symbol" && typeof s != "boolean" ? e.name = "" + Xt(s) : e.removeAttribute("name");
	}
	function an(e, t, n, r, i, a, o, s) {
		if (a != null && typeof a != "function" && typeof a != "symbol" && typeof a != "boolean" && (e.type = a), t != null || n != null) {
			if (!(a !== "submit" && a !== "reset" || t != null)) {
				$t(e);
				return;
			}
			n = n == null ? "" : "" + Xt(n), t = t == null ? n : "" + Xt(t), s || t === e.value || (e.value = t), e.defaultValue = t;
		}
		r ??= i, r = typeof r != "function" && typeof r != "symbol" && !!r, e.checked = s ? e.checked : !!r, e.defaultChecked = !!r, o != null && typeof o != "function" && typeof o != "symbol" && typeof o != "boolean" && (e.name = o), $t(e);
	}
	function on(e, t) {
		e.defaultValue !== "" + t && (e.defaultValue = "" + t);
	}
	function sn(e, t, n, r) {
		if (e = e.options, t) {
			t = {};
			for (var i = 0; i < n.length; i++) t["$" + n[i]] = !0;
			for (n = 0; n < e.length; n++) i = t.hasOwnProperty("$" + e[n].value), e[n].selected !== i && (e[n].selected = i), i && r && (e[n].defaultSelected = !0);
		} else {
			for (n = "" + Xt(n), t = null, i = 0; i < e.length; i++) {
				if (e[i].value === n) {
					e[i].selected = !0, r && (e[i].defaultSelected = !0);
					return;
				}
				t !== null || e[i].disabled || (t = e[i]);
			}
			t !== null && (t.selected = !0);
		}
	}
	function cn(e, t, n) {
		if (t != null && (t = "" + Xt(t), t !== e.value && (e.value = t), n == null)) {
			e.defaultValue !== t && (e.defaultValue = t);
			return;
		}
		e.defaultValue = n == null ? "" : "" + Xt(n);
	}
	function ln(e, t, n, r) {
		if (t == null) {
			if (r != null) {
				if (n != null) throw Error(i(92));
				if (he(r)) {
					if (1 < r.length) throw Error(i(93));
					r = r[0];
				}
				n = r;
			}
			n ??= "", t = n;
		}
		n = Xt(t), e.defaultValue = n, r = e.textContent, r === n && r !== "" && r !== null && (e.value = r), $t(e);
	}
	function un(e, t) {
		if (t) {
			var n = e.firstChild;
			if (n && n === e.lastChild && n.nodeType === 3) {
				n.nodeValue = t;
				return;
			}
		}
		e.textContent = t;
	}
	var dn = new Set("animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(" "));
	function fn(e, t, n) {
		var r = t.indexOf("--") === 0;
		n == null || typeof n == "boolean" || n === "" ? r ? e.setProperty(t, "") : t === "float" ? e.cssFloat = "" : e[t] = "" : r ? e.setProperty(t, n) : typeof n != "number" || n === 0 || dn.has(t) ? t === "float" ? e.cssFloat = n : e[t] = ("" + n).trim() : e[t] = n + "px";
	}
	function pn(e, t, n) {
		if (t != null && typeof t != "object") throw Error(i(62));
		if (e = e.style, n != null) {
			for (var r in n) !n.hasOwnProperty(r) || t != null && t.hasOwnProperty(r) || (r.indexOf("--") === 0 ? e.setProperty(r, "") : r === "float" ? e.cssFloat = "" : e[r] = "", z = !0);
			for (var a in t) r = t[a], t.hasOwnProperty(a) && n[a] !== r && (fn(e, a, r), z = !0);
		} else for (var o in t) t.hasOwnProperty(o) && fn(e, o, t[o]);
	}
	function mn(e) {
		if (e.indexOf("-") === -1) return !1;
		switch (e) {
			case "annotation-xml":
			case "color-profile":
			case "font-face":
			case "font-face-src":
			case "font-face-uri":
			case "font-face-format":
			case "font-face-name":
			case "missing-glyph": return !1;
			default: return !0;
		}
	}
	var hn = /* @__PURE__ */ new Map([
		["acceptCharset", "accept-charset"],
		["htmlFor", "for"],
		["httpEquiv", "http-equiv"],
		["crossOrigin", "crossorigin"],
		["accentHeight", "accent-height"],
		["alignmentBaseline", "alignment-baseline"],
		["arabicForm", "arabic-form"],
		["baselineShift", "baseline-shift"],
		["capHeight", "cap-height"],
		["clipPath", "clip-path"],
		["clipRule", "clip-rule"],
		["colorInterpolation", "color-interpolation"],
		["colorInterpolationFilters", "color-interpolation-filters"],
		["colorProfile", "color-profile"],
		["colorRendering", "color-rendering"],
		["dominantBaseline", "dominant-baseline"],
		["enableBackground", "enable-background"],
		["fillOpacity", "fill-opacity"],
		["fillRule", "fill-rule"],
		["floodColor", "flood-color"],
		["floodOpacity", "flood-opacity"],
		["fontFamily", "font-family"],
		["fontSize", "font-size"],
		["fontSizeAdjust", "font-size-adjust"],
		["fontStretch", "font-stretch"],
		["fontStyle", "font-style"],
		["fontVariant", "font-variant"],
		["fontWeight", "font-weight"],
		["glyphName", "glyph-name"],
		["glyphOrientationHorizontal", "glyph-orientation-horizontal"],
		["glyphOrientationVertical", "glyph-orientation-vertical"],
		["horizAdvX", "horiz-adv-x"],
		["horizOriginX", "horiz-origin-x"],
		["imageRendering", "image-rendering"],
		["letterSpacing", "letter-spacing"],
		["lightingColor", "lighting-color"],
		["markerEnd", "marker-end"],
		["markerMid", "marker-mid"],
		["markerStart", "marker-start"],
		["maskType", "mask-type"],
		["overlinePosition", "overline-position"],
		["overlineThickness", "overline-thickness"],
		["paintOrder", "paint-order"],
		["panose-1", "panose-1"],
		["pointerEvents", "pointer-events"],
		["renderingIntent", "rendering-intent"],
		["shapeRendering", "shape-rendering"],
		["stopColor", "stop-color"],
		["stopOpacity", "stop-opacity"],
		["strikethroughPosition", "strikethrough-position"],
		["strikethroughThickness", "strikethrough-thickness"],
		["strokeDasharray", "stroke-dasharray"],
		["strokeDashoffset", "stroke-dashoffset"],
		["strokeLinecap", "stroke-linecap"],
		["strokeLinejoin", "stroke-linejoin"],
		["strokeMiterlimit", "stroke-miterlimit"],
		["strokeOpacity", "stroke-opacity"],
		["strokeWidth", "stroke-width"],
		["textAnchor", "text-anchor"],
		["textDecoration", "text-decoration"],
		["textRendering", "text-rendering"],
		["transformOrigin", "transform-origin"],
		["underlinePosition", "underline-position"],
		["underlineThickness", "underline-thickness"],
		["unicodeBidi", "unicode-bidi"],
		["unicodeRange", "unicode-range"],
		["unitsPerEm", "units-per-em"],
		["vAlphabetic", "v-alphabetic"],
		["vHanging", "v-hanging"],
		["vIdeographic", "v-ideographic"],
		["vMathematical", "v-mathematical"],
		["vectorEffect", "vector-effect"],
		["vertAdvY", "vert-adv-y"],
		["vertOriginX", "vert-origin-x"],
		["vertOriginY", "vert-origin-y"],
		["wordSpacing", "word-spacing"],
		["writingMode", "writing-mode"],
		["xmlnsXlink", "xmlns:xlink"],
		["xHeight", "x-height"]
	]), gn = /^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;
	function _n(e) {
		return gn.test("" + e) ? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')" : e;
	}
	function vn() {}
	var yn = null;
	function bn(e) {
		return e = e.target || e.srcElement || window, e.correspondingUseElement && (e = e.correspondingUseElement), e.nodeType === 3 ? e.parentNode : e;
	}
	var xn = null, Sn = null;
	function Cn(e) {
		var t = Nt(e);
		if (t && (e = t.stateNode)) {
			var n = e[Ct] || null;
			a: switch (e = t.stateNode, t.type) {
				case "input":
					if (rn(e, n.value, n.defaultValue, n.defaultValue, n.checked, n.defaultChecked, n.type, n.name), t = n.name, n.type === "radio" && t != null) {
						for (n = e; n.parentNode;) n = n.parentNode;
						for (n = n.querySelectorAll("input[name=\"" + nn("" + t) + "\"][type=\"radio\"]"), t = 0; t < n.length; t++) {
							var r = n[t];
							if (r !== e && r.form === e.form) {
								var a = r[Ct] || null;
								if (!a) throw Error(i(90));
								rn(r, a.value, a.defaultValue, a.defaultValue, a.checked, a.defaultChecked, a.type, a.name);
							}
						}
						for (t = 0; t < n.length; t++) r = n[t], r.form === e.form && en(r);
					}
					break a;
				case "textarea":
					cn(e, n.value, n.defaultValue);
					break a;
				case "select": t = n.value, t != null && sn(e, !!n.multiple, t, !1);
			}
		}
	}
	var wn = !1;
	function Tn(e, t, n) {
		if (wn) return e(t, n);
		wn = !0;
		try {
			return e(t);
		} finally {
			if (wn = !1, (xn !== null || Sn !== null) && (Hd(), xn && (t = xn, e = Sn, Sn = xn = null, Cn(t), e))) for (t = 0; t < e.length; t++) Cn(e[t]);
		}
	}
	function En(e, t) {
		var n = e.stateNode;
		if (n === null) return null;
		var r = n[Ct] || null;
		if (r === null) return null;
		n = r[t];
		a: switch (t) {
			case "onClick":
			case "onClickCapture":
			case "onDoubleClick":
			case "onDoubleClickCapture":
			case "onMouseDown":
			case "onMouseDownCapture":
			case "onMouseMove":
			case "onMouseMoveCapture":
			case "onMouseUp":
			case "onMouseUpCapture":
			case "onMouseEnter":
				(r = !r.disabled) || (e = e.type, r = e !== "button" && e !== "input" && e !== "select" && e !== "textarea"), e = !r;
				break a;
			default: e = !1;
		}
		if (e) return null;
		if (n && typeof n != "function") throw Error(i(231, t, typeof n));
		return n;
	}
	var Dn = typeof window < "u" && window.document !== void 0 && window.document.createElement !== void 0, On = !1;
	if (Dn) try {
		var kn = {};
		Object.defineProperty(kn, "passive", { get: function() {
			On = !0;
		} }), window.addEventListener("test", kn, kn), window.removeEventListener("test", kn, kn);
	} catch {
		On = !1;
	}
	var An = null, jn = null, Mn = null;
	function Nn() {
		if (Mn) return Mn;
		var e, t = jn, n = t.length, r, i = "value" in An ? An.value : An.textContent, a = i.length;
		for (e = 0; e < n && t[e] === i[e]; e++);
		var o = n - e;
		for (r = 1; r <= o && t[n - r] === i[a - r]; r++);
		return Mn = i.slice(e, 1 < r ? 1 - r : void 0);
	}
	function Pn(e) {
		var t = e.keyCode;
		return "charCode" in e ? (e = e.charCode, e === 0 && t === 13 && (e = 13)) : e = t, e === 10 && (e = 13), 32 <= e || e === 13 ? e : 0;
	}
	function Fn() {
		return !0;
	}
	function In() {
		return !1;
	}
	function Ln(e) {
		function t(t, n, r, i, a) {
			for (var o in this._reactName = t, this._targetInst = r, this.type = n, this.nativeEvent = i, this.target = a, this.currentTarget = null, e) e.hasOwnProperty(o) && (t = e[o], this[o] = t ? t(i) : i[o]);
			return this.isDefaultPrevented = (i.defaultPrevented == null ? !1 === i.returnValue : i.defaultPrevented) ? Fn : In, this.isPropagationStopped = In, this;
		}
		return D(t.prototype, {
			preventDefault: function() {
				this.defaultPrevented = !0;
				var e = this.nativeEvent;
				e && (e.preventDefault ? e.preventDefault() : typeof e.returnValue != "unknown" && (e.returnValue = !1), this.isDefaultPrevented = Fn);
			},
			stopPropagation: function() {
				var e = this.nativeEvent;
				e && (e.stopPropagation ? e.stopPropagation() : typeof e.cancelBubble != "unknown" && (e.cancelBubble = !0), this.isPropagationStopped = Fn);
			},
			persist: function() {},
			isPersistent: Fn
		}), t;
	}
	var Rn = {
		eventPhase: 0,
		bubbles: 0,
		cancelable: 0,
		timeStamp: function(e) {
			return e.timeStamp || Date.now();
		},
		defaultPrevented: 0,
		isTrusted: 0
	}, zn = Ln(Rn), Bn = D({}, Rn, {
		view: 0,
		detail: 0
	}), Vn = Ln(Bn), Hn, Un, Wn, Gn = D({}, Bn, {
		screenX: 0,
		screenY: 0,
		clientX: 0,
		clientY: 0,
		pageX: 0,
		pageY: 0,
		ctrlKey: 0,
		shiftKey: 0,
		altKey: 0,
		metaKey: 0,
		getModifierState: nr,
		button: 0,
		buttons: 0,
		relatedTarget: function(e) {
			return e.relatedTarget === void 0 ? e.fromElement === e.srcElement ? e.toElement : e.fromElement : e.relatedTarget;
		},
		movementX: function(e) {
			return "movementX" in e ? e.movementX : (e !== Wn && (Wn && e.type === "mousemove" ? (Hn = e.screenX - Wn.screenX, Un = e.screenY - Wn.screenY) : Un = Hn = 0, Wn = e), Hn);
		},
		movementY: function(e) {
			return "movementY" in e ? e.movementY : Un;
		}
	}), Kn = Ln(Gn), qn = Ln(D({}, Gn, { dataTransfer: 0 })), Jn = Ln(D({}, Bn, { relatedTarget: 0 })), Yn = Ln(D({}, Rn, {
		animationName: 0,
		elapsedTime: 0,
		pseudoElement: 0
	})), Xn = Ln(D({}, Rn, { clipboardData: function(e) {
		return "clipboardData" in e ? e.clipboardData : window.clipboardData;
	} })), Zn = Ln(D({}, Rn, { data: 0 })), Qn = {
		Esc: "Escape",
		Spacebar: " ",
		Left: "ArrowLeft",
		Up: "ArrowUp",
		Right: "ArrowRight",
		Down: "ArrowDown",
		Del: "Delete",
		Win: "OS",
		Menu: "ContextMenu",
		Apps: "ContextMenu",
		Scroll: "ScrollLock",
		MozPrintableKey: "Unidentified"
	}, $n = {
		8: "Backspace",
		9: "Tab",
		12: "Clear",
		13: "Enter",
		16: "Shift",
		17: "Control",
		18: "Alt",
		19: "Pause",
		20: "CapsLock",
		27: "Escape",
		32: " ",
		33: "PageUp",
		34: "PageDown",
		35: "End",
		36: "Home",
		37: "ArrowLeft",
		38: "ArrowUp",
		39: "ArrowRight",
		40: "ArrowDown",
		45: "Insert",
		46: "Delete",
		112: "F1",
		113: "F2",
		114: "F3",
		115: "F4",
		116: "F5",
		117: "F6",
		118: "F7",
		119: "F8",
		120: "F9",
		121: "F10",
		122: "F11",
		123: "F12",
		144: "NumLock",
		145: "ScrollLock",
		224: "Meta"
	}, er = {
		Alt: "altKey",
		Control: "ctrlKey",
		Meta: "metaKey",
		Shift: "shiftKey"
	};
	function tr(e) {
		var t = this.nativeEvent;
		return t.getModifierState ? t.getModifierState(e) : (e = er[e]) ? !!t[e] : !1;
	}
	function nr() {
		return tr;
	}
	var rr = Ln(D({}, Bn, {
		key: function(e) {
			if (e.key) {
				var t = Qn[e.key] || e.key;
				if (t !== "Unidentified") return t;
			}
			return e.type === "keypress" ? (e = Pn(e), e === 13 ? "Enter" : String.fromCharCode(e)) : e.type === "keydown" || e.type === "keyup" ? $n[e.keyCode] || "Unidentified" : "";
		},
		code: 0,
		location: 0,
		ctrlKey: 0,
		shiftKey: 0,
		altKey: 0,
		metaKey: 0,
		repeat: 0,
		locale: 0,
		getModifierState: nr,
		charCode: function(e) {
			return e.type === "keypress" ? Pn(e) : 0;
		},
		keyCode: function(e) {
			return e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
		},
		which: function(e) {
			return e.type === "keypress" ? Pn(e) : e.type === "keydown" || e.type === "keyup" ? e.keyCode : 0;
		}
	})), ir = Ln(D({}, Gn, {
		pointerId: 0,
		width: 0,
		height: 0,
		pressure: 0,
		tangentialPressure: 0,
		tiltX: 0,
		tiltY: 0,
		twist: 0,
		pointerType: 0,
		isPrimary: 0
	})), ar = Ln(D({}, Rn, { submitter: 0 })), or = Ln(D({}, Bn, {
		touches: 0,
		targetTouches: 0,
		changedTouches: 0,
		altKey: 0,
		metaKey: 0,
		ctrlKey: 0,
		shiftKey: 0,
		getModifierState: nr
	})), sr = Ln(D({}, Rn, {
		propertyName: 0,
		elapsedTime: 0,
		pseudoElement: 0
	})), cr = Ln(D({}, Gn, {
		deltaX: function(e) {
			return "deltaX" in e ? e.deltaX : "wheelDeltaX" in e ? -e.wheelDeltaX : 0;
		},
		deltaY: function(e) {
			return "deltaY" in e ? e.deltaY : "wheelDeltaY" in e ? -e.wheelDeltaY : "wheelDelta" in e ? -e.wheelDelta : 0;
		},
		deltaZ: 0,
		deltaMode: 0
	})), lr = Ln(D({}, Rn, {
		newState: 0,
		oldState: 0,
		source: 0
	})), ur = [
		9,
		13,
		27,
		32
	], dr = Dn && "CompositionEvent" in window, fr = null;
	Dn && "documentMode" in document && (fr = document.documentMode);
	var pr = Dn && "TextEvent" in window && !fr, mr = Dn && (!dr || fr && 8 < fr && 11 >= fr), hr = " ", gr = !1;
	function _r(e, t) {
		switch (e) {
			case "keyup": return ur.indexOf(t.keyCode) !== -1;
			case "keydown": return t.keyCode !== 229;
			case "keypress":
			case "mousedown":
			case "focusout": return !0;
			default: return !1;
		}
	}
	function vr(e) {
		return e = e.detail, typeof e == "object" && "data" in e ? e.data : null;
	}
	var yr = !1;
	function br(e, t) {
		switch (e) {
			case "compositionend": return vr(t);
			case "keypress": return t.which === 32 ? (gr = !0, hr) : null;
			case "textInput": return e = t.data, e === hr && gr ? null : e;
			default: return null;
		}
	}
	function xr(e, t) {
		if (yr) return e === "compositionend" || !dr && _r(e, t) ? (e = Nn(), Mn = jn = An = null, yr = !1, e) : null;
		switch (e) {
			case "paste": return null;
			case "keypress":
				if (!(t.ctrlKey || t.altKey || t.metaKey) || t.ctrlKey && t.altKey) {
					if (t.char && 1 < t.char.length) return t.char;
					if (t.which) return String.fromCharCode(t.which);
				}
				return null;
			case "compositionend": return mr && t.locale !== "ko" ? null : t.data;
			default: return null;
		}
	}
	var Sr = {
		color: !0,
		date: !0,
		datetime: !0,
		"datetime-local": !0,
		email: !0,
		month: !0,
		number: !0,
		password: !0,
		range: !0,
		search: !0,
		tel: !0,
		text: !0,
		time: !0,
		url: !0,
		week: !0
	};
	function Cr(e) {
		var t = e && e.nodeName && e.nodeName.toLowerCase();
		return t === "input" ? !!Sr[e.type] : t === "textarea";
	}
	function wr(e, t, n, r) {
		xn ? Sn ? Sn.push(r) : Sn = [r] : xn = r, t = Qf(t, "onChange"), 0 < t.length && (n = new zn("onChange", "change", null, n, r), e.push({
			event: n,
			listeners: t
		}));
	}
	var Tr = null, Er = null;
	function Dr(e) {
		Gf(e, 0);
	}
	function Or(e) {
		if (en(Pt(e))) return e;
	}
	function kr(e, t) {
		if (e === "change") return t;
	}
	var Ar = !1;
	if (Dn) {
		var jr;
		if (Dn) {
			var Mr = "oninput" in document;
			if (!Mr) {
				var Nr = document.createElement("div");
				Nr.setAttribute("oninput", "return;"), Mr = typeof Nr.oninput == "function";
			}
			jr = Mr;
		} else jr = !1;
		Ar = jr && (!document.documentMode || 9 < document.documentMode);
	}
	function Pr() {
		Tr && (Tr.detachEvent("onpropertychange", Fr), Er = Tr = null);
	}
	function Fr(e) {
		if (e.propertyName === "value" && Or(Er)) {
			var t = [];
			wr(t, Er, e, bn(e)), Tn(Dr, t);
		}
	}
	function Ir(e, t, n) {
		e === "focusin" ? (Pr(), Tr = t, Er = n, Tr.attachEvent("onpropertychange", Fr)) : e === "focusout" && Pr();
	}
	function Lr(e) {
		if (e === "selectionchange" || e === "keyup" || e === "keydown") return Or(Er);
	}
	function Rr(e, t) {
		if (e === "click") return Or(t);
	}
	function zr(e, t) {
		if (e === "input" || e === "change") return Or(t);
	}
	function Br(e, t) {
		return e === t && (e !== 0 || 1 / e == 1 / t) || e !== e && t !== t;
	}
	var Vr = typeof Object.is == "function" ? Object.is : Br;
	function Hr(e, t) {
		if (Vr(e, t)) return !0;
		if (typeof e != "object" || !e || typeof t != "object" || !t) return !1;
		var n = Object.keys(e), r = Object.keys(t);
		if (n.length !== r.length) return !1;
		for (r = 0; r < n.length; r++) {
			var i = n[r];
			if (!Le.call(t, i) || !Vr(e[i], t[i])) return !1;
		}
		return !0;
	}
	function Ur(e) {
		if (e ||= typeof document < "u" ? document : void 0, e === void 0) return null;
		try {
			return e.activeElement || e.body;
		} catch {
			return e.body;
		}
	}
	function Wr(e) {
		for (; e && e.firstChild;) e = e.firstChild;
		return e;
	}
	function Gr(e, t) {
		var n = Wr(e);
		e = 0;
		for (var r; n;) {
			if (n.nodeType === 3) {
				if (r = e + n.textContent.length, e <= t && r >= t) return {
					node: n,
					offset: t - e
				};
				e = r;
			}
			a: {
				for (; n;) {
					if (n.nextSibling) {
						n = n.nextSibling;
						break a;
					}
					n = n.parentNode;
				}
				n = void 0;
			}
			n = Wr(n);
		}
	}
	function Kr(e, t) {
		return e && t ? e === t ? !0 : e && e.nodeType === 3 ? !1 : t && t.nodeType === 3 ? Kr(e, t.parentNode) : "contains" in e ? e.contains(t) : e.compareDocumentPosition ? !!(e.compareDocumentPosition(t) & 16) : !1 : !1;
	}
	function qr(e) {
		e = e != null && e.ownerDocument != null && e.ownerDocument.defaultView != null ? e.ownerDocument.defaultView : window;
		for (var t = Ur(e.document); t instanceof e.HTMLIFrameElement;) {
			try {
				var n = typeof t.contentWindow.location.href == "string";
			} catch {
				n = !1;
			}
			if (n) e = t.contentWindow;
			else break;
			t = Ur(e.document);
		}
		return t;
	}
	function Jr(e) {
		var t = e && e.nodeName && e.nodeName.toLowerCase();
		return t && (t === "input" && (e.type === "text" || e.type === "search" || e.type === "tel" || e.type === "url" || e.type === "password") || t === "textarea" || e.contentEditable === "true");
	}
	var Yr = Dn && "documentMode" in document && 11 >= document.documentMode, Xr = null, Zr = null, B = null, Qr = !1;
	function $r(e, t, n) {
		var r = n.window === n ? n.document : n.nodeType === 9 ? n : n.ownerDocument;
		Qr || Xr == null || Xr !== Ur(r) || (r = Xr, "selectionStart" in r && Jr(r) ? r = {
			start: r.selectionStart,
			end: r.selectionEnd
		} : (r = (r.ownerDocument && r.ownerDocument.defaultView || window).getSelection(), r = {
			anchorNode: r.anchorNode,
			anchorOffset: r.anchorOffset,
			focusNode: r.focusNode,
			focusOffset: r.focusOffset
		}), B && Hr(B, r) || (B = r, r = Qf(Zr, "onSelect"), 0 < r.length && (t = new zn("onSelect", "select", null, t, n), e.push({
			event: t,
			listeners: r
		}), t.target = Xr)));
	}
	function ei(e, t) {
		var n = {};
		return n[e.toLowerCase()] = t.toLowerCase(), n["Webkit" + e] = "webkit" + t, n["Moz" + e] = "moz" + t, n;
	}
	var ti = {
		animationend: ei("Animation", "AnimationEnd"),
		animationiteration: ei("Animation", "AnimationIteration"),
		animationstart: ei("Animation", "AnimationStart"),
		transitionrun: ei("Transition", "TransitionRun"),
		transitionstart: ei("Transition", "TransitionStart"),
		transitioncancel: ei("Transition", "TransitionCancel"),
		transitionend: ei("Transition", "TransitionEnd")
	}, ni = {}, ri = {};
	Dn && (ri = document.createElement("div").style, "AnimationEvent" in window || (delete ti.animationend.animation, delete ti.animationiteration.animation, delete ti.animationstart.animation), "TransitionEvent" in window || delete ti.transitionend.transition);
	function ii(e) {
		if (ni[e]) return ni[e];
		if (!ti[e]) return e;
		var t = ti[e], n;
		for (n in t) if (t.hasOwnProperty(n) && n in ri) return ni[e] = t[n];
		return e;
	}
	var ai = ii("animationend"), oi = ii("animationiteration"), si = ii("animationstart"), ci = ii("transitionrun"), li = ii("transitionstart"), ui = ii("transitioncancel"), di = ii("transitionend"), fi = /* @__PURE__ */ new Map(), pi = "abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error fullscreenChange fullscreenError gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");
	pi.push("scrollEnd");
	function mi(e, t) {
		fi.set(e, t), Bt(t, [e]);
	}
	var hi = 0;
	function gi(e, t) {
		if (e.name != null && e.name !== "auto") return e.name;
		if (t.autoName !== null) return t.autoName;
		e = Cd.identifierPrefix;
		var n = hi++;
		return e = "_" + e + "t_" + n.toString(32) + "_", t.autoName = e;
	}
	function _i(e) {
		if (e == null || typeof e == "string") return e;
		var t = null, n = jd;
		if (n !== null) for (var r = 0; r < n.length; r++) {
			var i = e[n[r]];
			if (i != null) {
				if (i === "none") return "none";
				t = t == null ? i : t + (" " + i);
			}
		}
		return t ?? e.default;
	}
	function vi(e, t) {
		return e = _i(e), t = _i(t), t == null ? e === "auto" ? null : e : t === "auto" ? null : t;
	}
	var yi = typeof reportError == "function" ? reportError : function(e) {
		if (typeof window == "object" && typeof window.ErrorEvent == "function") {
			var t = new window.ErrorEvent("error", {
				bubbles: !0,
				cancelable: !0,
				message: typeof e == "object" && e && typeof e.message == "string" ? String(e.message) : String(e),
				error: e
			});
			if (!window.dispatchEvent(t)) return;
		} else if (typeof process == "object" && typeof process.emit == "function") {
			process.emit("uncaughtException", e);
			return;
		}
		console.error(e);
	}, bi = [], xi = 0, Si = 0;
	function Ci() {
		for (var e = xi, t = Si = xi = 0; t < e;) {
			var n = bi[t];
			bi[t++] = null;
			var r = bi[t];
			bi[t++] = null;
			var i = bi[t];
			bi[t++] = null;
			var a = bi[t];
			if (bi[t++] = null, r !== null && i !== null) {
				var o = r.pending;
				o === null ? i.next = i : (i.next = o.next, o.next = i), r.pending = i;
			}
			a !== 0 && Di(n, i, a);
		}
	}
	function wi(e, t, n, r) {
		bi[xi++] = e, bi[xi++] = t, bi[xi++] = n, bi[xi++] = r, Si |= r, e.lanes |= r, e = e.alternate, e !== null && (e.lanes |= r);
	}
	function Ti(e, t, n, r) {
		return wi(e, t, n, r), Oi(e);
	}
	function Ei(e, t) {
		return wi(e, null, null, t), Oi(e);
	}
	function Di(e, t, n) {
		e.lanes |= n;
		var r = e.alternate;
		r !== null && (r.lanes |= n);
		for (var i = !1, a = e.return; a !== null;) a.childLanes |= n, r = a.alternate, r !== null && (r.childLanes |= n), a.tag === 22 && (e = a.stateNode, e === null || e._visibility & 1 || (i = !0)), e = a, a = a.return;
		return e.tag === 3 ? (a = e.stateNode, i && t !== null && (i = 31 - $e(n), e = a.hiddenUpdates, r = e[i], r === null ? e[i] = [t] : r.push(t), t.lane = n | 536870912), a) : null;
	}
	function Oi(e) {
		if (50 < Md) throw Md = 0, Nd = null, Error(i(185));
		for (var t = e.return; t !== null;) e = t, t = e.return;
		return e.tag === 3 ? e.stateNode : null;
	}
	var ki = {};
	function Ai(e, t, n, r) {
		this.tag = e, this.key = n, this.sibling = this.child = this.return = this.stateNode = this.type = this.elementType = null, this.index = 0, this.refCleanup = this.ref = null, this.pendingProps = t, this.dependencies = this.memoizedState = this.updateQueue = this.memoizedProps = null, this.mode = r, this.subtreeFlags = this.flags = 0, this.deletions = null, this.childLanes = this.lanes = 0, this.alternate = null;
	}
	function ji(e, t, n, r) {
		return new Ai(e, t, n, r);
	}
	function Mi(e) {
		return e = e.prototype, !(!e || !e.isReactComponent);
	}
	function Ni(e, t) {
		var n = e.alternate;
		return n === null ? (n = ji(e.tag, t, e.key, e.mode), n.elementType = e.elementType, n.type = e.type, n.stateNode = e.stateNode, n.alternate = e, e.alternate = n) : (n.pendingProps = t, n.type = e.type, n.flags = 0, n.subtreeFlags = 0, n.deletions = null), n.flags = e.flags & 1206910976, n.childLanes = e.childLanes, n.lanes = e.lanes, n.child = e.child, n.memoizedProps = e.memoizedProps, n.memoizedState = e.memoizedState, n.updateQueue = e.updateQueue, t = e.dependencies, n.dependencies = t === null ? null : {
			lanes: t.lanes,
			firstContext: t.firstContext
		}, n.sibling = e.sibling, n.index = e.index, n.ref = e.ref, n.refCleanup = e.refCleanup, n;
	}
	function Pi(e, t) {
		e.flags &= 1206910978;
		var n = e.alternate;
		return n === null ? (e.childLanes = 0, e.lanes = t, e.child = null, e.subtreeFlags = 0, e.memoizedProps = null, e.memoizedState = null, e.updateQueue = null, e.dependencies = null, e.stateNode = null) : (e.childLanes = n.childLanes, e.lanes = n.lanes, e.child = n.child, e.subtreeFlags = 0, e.deletions = null, e.memoizedProps = n.memoizedProps, e.memoizedState = n.memoizedState, e.updateQueue = n.updateQueue, e.type = n.type, t = n.dependencies, e.dependencies = t === null ? null : {
			lanes: t.lanes,
			firstContext: t.firstContext
		}), e;
	}
	function Fi(e, t, n, r, a, o) {
		var s = 0;
		if (r = e, typeof r == "function") Mi(r) && (s = 1);
		else if (typeof r == "string") s = Xm(e, n, Se.current) ? 26 : e === "html" || e === "head" || e === "body" ? 27 : 5;
		else a: switch (r) {
			case oe: return e = ji(31, n, t, a), e.elementType = oe, e.lanes = o, e;
			case A: return Ii(n.children, a, o, t);
			case te:
				s = 8, a |= 24;
				break;
			case ne: return e = ji(12, n, t, a | 2), e.elementType = ne, e.lanes = o, e;
			case N: return e = ji(13, n, t, a), e.elementType = N, e.lanes = o, e;
			case P: return e = ji(19, n, t, a), e.elementType = P, e.lanes = o, e;
			case se:
			case le: return e = a | 32, e = ji(30, n, t, e), e.elementType = le, e.lanes = o, e.stateNode = {
				autoName: null,
				paired: null,
				clones: null,
				ref: null
			}, e;
			default:
				if (typeof r == "object" && r) switch (r.$$typeof) {
					case M:
						s = 10;
						break a;
					case j:
						s = 9;
						break a;
					case re:
						s = 11;
						break a;
					case ie:
						s = 14;
						break a;
					case ae:
						s = 16, r = null;
						break a;
				}
				s = 29, n = Error(i(130, e === null ? "null" : typeof e, "")), r = null;
		}
		return t = ji(s, n, t, a), t.elementType = e, t.type = r, t.lanes = o, t;
	}
	function Ii(e, t, n, r) {
		return e = ji(7, e, r, t), e.lanes = n, e;
	}
	function Li(e, t, n) {
		return e = ji(6, e, null, t), e.lanes = n, e;
	}
	function Ri(e) {
		var t = ji(18, null, null, 0);
		return t.stateNode = e, t;
	}
	function zi(e, t, n) {
		return t = ji(4, e.children === null ? [] : e.children, e.key, t), t.lanes = n, t.stateNode = {
			containerInfo: e.containerInfo,
			pendingChildren: null,
			implementation: e.implementation
		}, t;
	}
	var Bi = /* @__PURE__ */ new WeakMap();
	function Vi(e, t) {
		if (typeof e == "object" && e) {
			var n = Bi.get(e);
			return n === void 0 ? (t = {
				value: e,
				source: t,
				stack: Ie(t)
			}, Bi.set(e, t), t) : n;
		}
		return {
			value: e,
			source: t,
			stack: Ie(t)
		};
	}
	var Hi = [], Ui = 0, Wi = null, Gi = 0, Ki = [], qi = 0, Ji = null, Yi = 1, Xi = "";
	function Zi(e, t) {
		Hi[Ui++] = Gi, Hi[Ui++] = Wi, Wi = e, Gi = t;
	}
	function Qi(e, t, n) {
		Ki[qi++] = Yi, Ki[qi++] = Xi, Ki[qi++] = Ji, Ji = e;
		var r = Yi;
		e = Xi;
		var i = 32 - $e(r) - 1;
		r &= ~(1 << i), n += 1;
		var a = 32 - $e(t) + i;
		if (30 < a) {
			var o = i - i % 5;
			a = (r & (1 << o) - 1).toString(32), r >>= o, i -= o, Yi = 1 << 32 - $e(t) + i | n << i | r, Xi = a + e;
		} else Yi = 1 << a | n << i | r, Xi = e;
	}
	function $i(e) {
		e.return !== null && (Zi(e, 1), Qi(e, 1, 0));
	}
	function ea(e) {
		for (; e === Wi;) Wi = Hi[--Ui], Hi[Ui] = null, Gi = Hi[--Ui], Hi[Ui] = null;
		for (; e === Ji;) Ji = Ki[--qi], Ki[qi] = null, Xi = Ki[--qi], Ki[qi] = null, Yi = Ki[--qi], Ki[qi] = null;
	}
	function ta(e, t) {
		Ki[qi++] = Yi, Ki[qi++] = Xi, Ki[qi++] = Ji, Yi = t.id, Xi = t.overflow, Ji = e;
	}
	var na = null, ra = null, V = !1, ia = null, aa = !1, oa = Error(i(519));
	function sa(e) {
		throw pa(Vi(Error(i(418, 1 < arguments.length && arguments[1] !== void 0 && arguments[1] ? "text" : "HTML", "")), e)), oa;
	}
	function ca(e) {
		var t = e.stateNode, n = e.type, r = e.memoizedProps;
		switch (t[St] = e, t[Ct] = r, n) {
			case "dialog":
				J("cancel", t), J("close", t);
				break;
			case "iframe":
			case "object":
			case "embed":
				J("load", t);
				break;
			case "video":
			case "audio":
				for (n = 0; n < Uf.length; n++) J(Uf[n], t);
				break;
			case "source":
				J("error", t);
				break;
			case "img":
			case "image":
			case "link":
				J("error", t), J("load", t);
				break;
			case "details":
				J("toggle", t);
				break;
			case "input":
				J("invalid", t), an(t, r.value, r.defaultValue, r.checked, r.defaultChecked, r.type, r.name, !0);
				break;
			case "select":
				J("invalid", t);
				break;
			case "textarea": J("invalid", t), ln(t, r.value, r.defaultValue, r.children);
		}
		n = r.children, typeof n != "string" && typeof n != "number" && typeof n != "bigint" || t.textContent === "" + n || !0 === r.suppressHydrationWarning || ip(t.textContent, n) ? (r.popover != null && (J("beforetoggle", t), J("toggle", t)), r.onScroll != null && J("scroll", t), r.onScrollEnd != null && J("scrollend", t), r.onClick != null && (t.onclick = vn), t = !0) : t = !1, t || sa(e, !0);
	}
	function la(e) {
		for (na = e.return; na;) switch (na.tag) {
			case 5:
			case 31:
			case 13:
				aa = !1;
				return;
			case 27:
			case 3:
				aa = !0;
				return;
			default: na = na.return;
		}
	}
	function ua(e) {
		if (e !== na) return !1;
		if (!V) return la(e), V = !0, !1;
		var t = e.tag, n;
		if ((n = t !== 3 && t !== 27) && ((n = t === 5) && (n = e.type, n = n === "form" || n === "button" || vp(e.type, e.memoizedProps)), n = !n), n && ra && sa(e), la(e), t === 13) {
			if (e = e.memoizedState, e = e === null ? null : e.dehydrated, !e) throw Error(i(317));
			ra = gm(e);
		} else if (t === 31) {
			if (e = e.memoizedState, e = e === null ? null : e.dehydrated, !e) throw Error(i(317));
			ra = gm(e);
		} else t === 27 ? (t = ra, Dp(e.type) ? (e = hm, hm = null, ra = e) : ra = t) : ra = na ? mm(e.stateNode.nextSibling) : null;
		return !0;
	}
	function da() {
		ra = na = null, V = !1;
	}
	function fa() {
		var e = ia;
		return e !== null && (hd === null ? hd = e : hd.push.apply(hd, e), ia = null), e;
	}
	function pa(e) {
		ia === null ? ia = [e] : ia.push(e);
	}
	var ma = ye(null), ha = null, ga = null;
	function _a(e, t, n) {
		xe(ma, t._currentValue), t._currentValue = n;
	}
	function va(e) {
		e._currentValue = ma.current, be(ma);
	}
	function ya(e, t, n) {
		for (; e !== null;) {
			var r = e.alternate;
			if ((e.childLanes & t) === t ? r !== null && (r.childLanes & t) !== t && (r.childLanes |= t) : (e.childLanes |= t, r !== null && (r.childLanes |= t)), e === n) break;
			e = e.return;
		}
	}
	function ba(e, t, n, r) {
		var a = e.child;
		for (a !== null && (a.return = e); a !== null;) {
			var o = a.dependencies;
			if (o !== null) {
				var s = a.child;
				o = o.firstContext;
				a: for (; o !== null;) {
					var c = o;
					o = a;
					for (var l = 0; l < t.length; l++) if (c.context === t[l]) {
						o.lanes |= n, c = o.alternate, c !== null && (c.lanes |= n), ya(o.return, n, e), r || (s = null);
						break a;
					}
					o = c.next;
				}
			} else if (a.tag === 18) {
				if (s = a.return, s === null) throw Error(i(341));
				s.lanes |= n, o = s.alternate, o !== null && (o.lanes |= n), ya(s, n, e), s = null;
			} else a.tag === 13 && a.memoizedState !== null && a.memoizedState.dehydrated === null ? (a.lanes |= n, s = a.alternate, s !== null && (s.lanes |= n), ya(a.return, n, e), s = a.child, s = s === null ? null : s.sibling) : s = a.child;
			if (s !== null) s.return = a;
			else for (s = a; s !== null;) {
				if (s === e) {
					s = null;
					break;
				}
				if (a = s.sibling, a !== null) {
					a.return = s.return, s = a;
					break;
				}
				s = s.return;
			}
			a = s;
		}
	}
	function xa(e, t, n, r) {
		e = null;
		for (var a = t, o = !1; a !== null;) {
			if (!o) {
				if (a.flags & 524288) o = !0;
				else if (a.flags & 262144) break;
			}
			if (a.tag === 10) {
				var s = a.alternate;
				if (s === null) throw Error(i(387));
				if (s = s.memoizedProps, s !== null) {
					var c = a.type;
					Vr(a.pendingProps.value, s.value) || (e === null ? e = [c] : e.push(c));
				}
			} else if (a === Te.current) {
				if (s = a.alternate, s === null) throw Error(i(387));
				s.memoizedState.memoizedState !== a.memoizedState.memoizedState && (e === null ? e = [uh] : e.push(uh));
			}
			a = a.return;
		}
		return e !== null && ba(t, e, n, r), t.flags |= 262144, e !== null;
	}
	function Sa(e) {
		for (e = e.firstContext; e !== null;) {
			if (!Vr(e.context._currentValue, e.memoizedValue)) return !0;
			e = e.next;
		}
		return !1;
	}
	function H(e) {
		ha = e, ga = null, e = e.dependencies, e !== null && (e.firstContext = null);
	}
	function Ca(e) {
		return Ta(ha, e);
	}
	function wa(e, t) {
		return ha === null && H(e), Ta(e, t);
	}
	function Ta(e, t) {
		var n = t._currentValue;
		if (t = {
			context: t,
			memoizedValue: n,
			next: null
		}, ga === null) {
			if (e === null) throw Error(i(308));
			ga = t, e.dependencies = {
				lanes: 0,
				firstContext: t
			}, e.flags |= 524288;
		} else ga = ga.next = t;
		return n;
	}
	var Ea = typeof AbortController < "u" ? AbortController : function() {
		var e = [], t = this.signal = {
			aborted: !1,
			addEventListener: function(t, n) {
				e.push(n);
			}
		};
		this.abort = function() {
			t.aborted = !0, e.forEach(function(e) {
				return e();
			});
		};
	}, Da = t.unstable_scheduleCallback, Oa = t.unstable_NormalPriority, ka = {
		$$typeof: M,
		Consumer: null,
		Provider: null,
		_currentValue: null,
		_currentValue2: null,
		_threadCount: 0
	};
	function Aa() {
		return {
			controller: new Ea(),
			data: /* @__PURE__ */ new Map(),
			refCount: 0
		};
	}
	function ja(e) {
		e.refCount--, e.refCount === 0 && Da(Oa, function() {
			e.controller.abort();
		});
	}
	function Ma(e, t) {
		if (e.pendingLanes & 4194048) {
			var n = e.transitionTypes;
			for (n === null && (n = e.transitionTypes = []), e = 0; e < t.length; e++) {
				var r = t[e];
				n.indexOf(r) === -1 && n.push(r);
			}
		}
	}
	var Na = null;
	function Pa(e) {
		var t = e.transitionTypes;
		return e.transitionTypes = null, t;
	}
	var Fa = null, Ia = 0, La = 0, Ra = null;
	function za(e, t) {
		if (Fa === null) {
			var n = Fa = [];
			Ia = 0, La = Rf(), Ra = {
				status: "pending",
				value: void 0,
				then: function(e) {
					n.push(e);
				}
			};
		}
		return Ia++, t.then(Ba, Ba), t;
	}
	function Ba() {
		if (--Ia === 0 && (Na = null, Fa !== null)) {
			Ra !== null && (Ra.status = "fulfilled");
			var e = Fa;
			Fa = null, La = 0, Ra = null;
			for (var t = 0; t < e.length; t++) (0, e[t])();
		}
	}
	function Va(e, t) {
		var n = [], r = {
			status: "pending",
			value: null,
			reason: null,
			then: function(e) {
				n.push(e);
			}
		};
		return e.then(function() {
			r.status = "fulfilled", r.value = t;
			for (var e = 0; e < n.length; e++) (0, n[e])(t);
		}, function(e) {
			for (r.status = "rejected", r.reason = e, e = 0; e < n.length; e++) (0, n[e])(void 0);
		}), r;
	}
	var Ha = F.S;
	F.S = function(e, t) {
		if (vd = He(), typeof t == "object" && t && typeof t.then == "function" && za(e, t), Na !== null) for (var n = wf; n !== null;) Ma(n, Na), n = n.next;
		if (n = e.types, n !== null) {
			for (var r = wf; r !== null;) Ma(r, n), r = r.next;
			if (La !== 0) {
				r = Na, r === null && (r = Na = []);
				for (var i = 0; i < n.length; i++) {
					var a = n[i];
					r.indexOf(a) === -1 && r.push(a);
				}
			}
		}
		Ha !== null && Ha(e, t);
	};
	var Ua = ye(null);
	function Wa() {
		var e = Ua.current;
		return e === null ? td.pooledCache : e;
	}
	function Ga(e, t) {
		t === null ? xe(Ua, Ua.current) : xe(Ua, t.pool);
	}
	function Ka() {
		var e = Wa();
		return e === null ? null : {
			parent: ka._currentValue,
			pool: e
		};
	}
	var qa = Error(i(460)), Ja = Error(i(474)), Ya = Error(i(542)), Xa = { then: function() {} };
	function Za(e) {
		return e = e.status, e === "fulfilled" || e === "rejected";
	}
	function Qa(e, t, n) {
		switch (n = e[n], n === void 0 ? e.push(t) : n !== t && (t.then(vn, vn), t = n), t.status) {
			case "fulfilled": return t.value;
			case "rejected": throw e = t.reason, no(e), e === void 0 && !("reason" in t) ? Error(i(600)) : e;
			default:
				if (typeof t.status == "string") t.then(vn, vn);
				else {
					if (e = td, e !== null && 100 < e.shellSuspendCounter) throw Error(i(482));
					e = t, e.status = "pending", e.then(function(e) {
						if (t.status === "pending") {
							var n = t;
							n.status = "fulfilled", n.value = e;
						}
					}, function(e) {
						if (t.status === "pending") {
							var n = t;
							n.status = "rejected", n.reason = e;
						}
					});
				}
				switch (t.status) {
					case "fulfilled": return t.value;
					case "rejected": throw e = t.reason, no(e), e;
				}
				throw eo = t, qa;
		}
	}
	function $a(e) {
		try {
			var t = e._init;
			return t(e._payload);
		} catch (e) {
			throw typeof e == "object" && e && typeof e.then == "function" ? (eo = e, qa) : e;
		}
	}
	var eo = null;
	function to() {
		if (eo === null) throw Error(i(459));
		var e = eo;
		return eo = null, e;
	}
	function no(e) {
		if (e === qa || e === Ya) throw Error(i(483));
	}
	var ro = null, io = 0;
	function ao(e) {
		var t = io;
		return io += 1, ro === null && (ro = []), Qa(ro, e, t);
	}
	function oo(e, t) {
		t = t.props.ref, e.ref = t === void 0 ? null : t;
	}
	function so(e, t) {
		throw t.$$typeof === O ? Error(i(525)) : (e = Object.prototype.toString.call(t), Error(i(31, e === "[object Object]" ? "object with keys {" + Object.keys(t).join(", ") + "}" : e)));
	}
	function co(e) {
		function t(t, n) {
			if (e) {
				var r = t.deletions;
				r === null ? (t.deletions = [n], t.flags |= 16) : r.push(n);
			}
		}
		function n(n, r) {
			if (!e) return null;
			for (; r !== null;) t(n, r), r = r.sibling;
			return null;
		}
		function r(e) {
			for (var t = /* @__PURE__ */ new Map(); e !== null;) e.key === null ? t.set(e.index, e) : t.set(e.key, e), e = e.sibling;
			return t;
		}
		function a(e, t) {
			return e = Ni(e, t), e.index = 0, e.sibling = null, e;
		}
		function o(t, n, r) {
			return t.index = r, e ? (r = t.alternate, r === null ? (t.flags |= 134217730, n) : (r = r.index, r < n ? (t.flags |= 2, n) : r)) : (t.flags |= 1048576, n);
		}
		function s(t) {
			return e && t.alternate === null && (t.flags |= 134217730), t;
		}
		function c(e, t, n, r) {
			return t === null || t.tag !== 6 ? (t = Li(n, e.mode, r), t.return = e, t) : (t = a(t, n), t.return = e, t);
		}
		function l(e, t, n, r) {
			var i = n.type;
			return i === A ? (e = d(e, t, n.props.children, r, n.key), oo(e, n), e) : t !== null && (t.elementType === i || typeof i == "object" && i && i.$$typeof === ae && $a(i) === t.type) ? (t = a(t, n.props), oo(t, n), t.return = e, t) : (t = Fi(n.type, n.key, n.props, null, e.mode, r), oo(t, n), t.return = e, t);
		}
		function u(e, t, n, r) {
			return t === null || t.tag !== 4 || t.stateNode.containerInfo !== n.containerInfo || t.stateNode.implementation !== n.implementation ? (t = zi(n, e.mode, r), t.return = e, t) : (t = a(t, n.children || []), t.return = e, t);
		}
		function d(e, t, n, r, i) {
			return t === null || t.tag !== 7 ? (t = Ii(n, e.mode, r, i), t.return = e, t) : (t = a(t, n), t.return = e, t);
		}
		function f(e, t, n) {
			if (typeof t == "string" && t !== "" || typeof t == "number" || typeof t == "bigint") return t = Li("" + t, e.mode, n), t.return = e, t;
			if (typeof t == "object" && t) {
				switch (t.$$typeof) {
					case k: return n = Fi(t.type, t.key, t.props, null, e.mode, n), oo(n, t), n.return = e, n;
					case ee: return t = zi(t, e.mode, n), t.return = e, t;
					case ae: return t = $a(t), f(e, t, n);
				}
				if (he(t) || fe(t)) return t = Ii(t, e.mode, n, null), t.return = e, t;
				if (typeof t.then == "function") return f(e, ao(t), n);
				if (t.$$typeof === M) return f(e, wa(e, t), n);
				so(e, t);
			}
			return null;
		}
		function p(e, t, n, r) {
			var i = t === null ? null : t.key;
			if (typeof n == "string" && n !== "" || typeof n == "number" || typeof n == "bigint") return i === null ? c(e, t, "" + n, r) : null;
			if (typeof n == "object" && n) {
				switch (n.$$typeof) {
					case k: return n.key === i ? l(e, t, n, r) : null;
					case ee: return n.key === i ? u(e, t, n, r) : null;
					case ae: return n = $a(n), p(e, t, n, r);
				}
				if (he(n) || fe(n)) return i === null ? d(e, t, n, r, null) : null;
				if (typeof n.then == "function") return p(e, t, ao(n), r);
				if (n.$$typeof === M) return p(e, t, wa(e, n), r);
				so(e, n);
			}
			return null;
		}
		function m(e, t, n, r, i) {
			if (typeof r == "string" && r !== "" || typeof r == "number" || typeof r == "bigint") return e = e.get(n) || null, c(t, e, "" + r, i);
			if (typeof r == "object" && r) {
				switch (r.$$typeof) {
					case k: return e = e.get(r.key === null ? n : r.key) || null, l(t, e, r, i);
					case ee: return e = e.get(r.key === null ? n : r.key) || null, u(t, e, r, i);
					case ae: return r = $a(r), m(e, t, n, r, i);
				}
				if (he(r) || fe(r)) return e = e.get(n) || null, d(t, e, r, i, null);
				if (typeof r.then == "function") return m(e, t, n, ao(r), i);
				if (r.$$typeof === M) return m(e, t, n, wa(t, r), i);
				so(t, r);
			}
			return null;
		}
		function h(i, a, s, c) {
			for (var l = null, u = null, d = a, h = a = 0, g = null; d !== null && h < s.length; h++) {
				d.index > h ? (g = d, d = null) : g = d.sibling;
				var _ = p(i, d, s[h], c);
				if (_ === null) {
					d === null && (d = g);
					break;
				}
				e && d && _.alternate === null && t(i, d), a = o(_, a, h), u === null ? l = _ : u.sibling = _, u = _, d = g;
			}
			if (h === s.length) return n(i, d), V && Zi(i, h), l;
			if (d === null) {
				for (; h < s.length; h++) d = f(i, s[h], c), d !== null && (a = o(d, a, h), u === null ? l = d : u.sibling = d, u = d);
				return V && Zi(i, h), l;
			}
			for (d = r(d); h < s.length; h++) g = m(d, i, h, s[h], c), g !== null && (e && (_ = g.alternate, _ !== null && d.delete(_.key === null ? h : _.key)), a = o(g, a, h), u === null ? l = g : u.sibling = g, u = g);
			return e && d.forEach(function(e) {
				return t(i, e);
			}), V && Zi(i, h), l;
		}
		function g(a, s, c, l) {
			if (c == null) throw Error(i(151));
			for (var u = null, d = null, h = s, g = s = 0, _ = null, v = c.next(); h !== null && !v.done; g++, v = c.next()) {
				h.index > g ? (_ = h, h = null) : _ = h.sibling;
				var y = p(a, h, v.value, l);
				if (y === null) {
					h === null && (h = _);
					break;
				}
				e && h && y.alternate === null && t(a, h), s = o(y, s, g), d === null ? u = y : d.sibling = y, d = y, h = _;
			}
			if (v.done) return n(a, h), V && Zi(a, g), u;
			if (h === null) {
				for (; !v.done; g++, v = c.next()) v = f(a, v.value, l), v !== null && (s = o(v, s, g), d === null ? u = v : d.sibling = v, d = v);
				return V && Zi(a, g), u;
			}
			for (h = r(h); !v.done; g++, v = c.next()) v = m(h, a, g, v.value, l), v !== null && (e && (_ = v.alternate, _ !== null && h.delete(_.key === null ? g : _.key)), s = o(v, s, g), d === null ? u = v : d.sibling = v, d = v);
			return e && h.forEach(function(e) {
				return t(a, e);
			}), V && Zi(a, g), u;
		}
		function _(e, r, o, c) {
			if (typeof o == "object" && o && o.type === A && o.key === null && o.props.ref === void 0 && (o = o.props.children), typeof o == "object" && o) {
				switch (o.$$typeof) {
					case k:
						a: {
							for (var l = o.key; r !== null;) {
								if (r.key === l) {
									if (l = o.type, l === A) {
										if (r.tag === 7) {
											n(e, r.sibling), c = a(r, o.props.children), oo(c, o), c.return = e, e = c;
											break a;
										}
									} else if (r.elementType === l || typeof l == "object" && l && l.$$typeof === ae && $a(l) === r.type) {
										n(e, r.sibling), c = a(r, o.props), oo(c, o), c.return = e, e = c;
										break a;
									}
									n(e, r);
									break;
								}
								t(e, r), r = r.sibling;
							}
							o.type === A ? (c = Ii(o.props.children, e.mode, c, o.key), oo(c, o), c.return = e, e = c) : (c = Fi(o.type, o.key, o.props, null, e.mode, c), oo(c, o), c.return = e, e = c);
						}
						return s(e);
					case ee:
						a: {
							for (l = o.key; r !== null;) {
								if (r.key === l) {
									if (r.tag === 4 && r.stateNode.containerInfo === o.containerInfo && r.stateNode.implementation === o.implementation) {
										n(e, r.sibling), c = a(r, o.children || []), c.return = e, e = c;
										break a;
									}
									n(e, r);
									break;
								}
								t(e, r), r = r.sibling;
							}
							c = zi(o, e.mode, c), c.return = e, e = c;
						}
						return s(e);
					case ae: return o = $a(o), _(e, r, o, c);
				}
				if (he(o)) return h(e, r, o, c);
				if (fe(o)) {
					if (l = fe(o), typeof l != "function") throw Error(i(150));
					return o = l.call(o), g(e, r, o, c);
				}
				if (typeof o.then == "function") return _(e, r, ao(o), c);
				if (o.$$typeof === M) return _(e, r, wa(e, o), c);
				so(e, o);
			}
			return typeof o == "string" && o !== "" || typeof o == "number" || typeof o == "bigint" ? (o = "" + o, r !== null && r.tag === 6 ? (n(e, r.sibling), c = a(r, o), c.return = e, e = c) : (n(e, r), c = Li(o, e.mode, c), c.return = e, e = c), s(e)) : n(e, r);
		}
		return function(e, t, n, r) {
			try {
				io = 0;
				var i = _(e, t, n, r);
				return ro = null, i;
			} catch (t) {
				if (t === qa || t === Ya) throw t;
				var a = ji(29, t, null, e.mode);
				return a.lanes = r, a.return = e, a;
			}
		};
	}
	var lo = co(!0), uo = co(!1), fo = !1;
	function po(e) {
		e.updateQueue = {
			baseState: e.memoizedState,
			firstBaseUpdate: null,
			lastBaseUpdate: null,
			shared: {
				pending: null,
				lanes: 0,
				hiddenCallbacks: null
			},
			callbacks: null
		};
	}
	function mo(e, t) {
		e = e.updateQueue, t.updateQueue === e && (t.updateQueue = {
			baseState: e.baseState,
			firstBaseUpdate: e.firstBaseUpdate,
			lastBaseUpdate: e.lastBaseUpdate,
			shared: e.shared,
			callbacks: null
		});
	}
	function ho(e) {
		return {
			lane: e,
			tag: 0,
			payload: null,
			callback: null,
			next: null
		};
	}
	function go(e, t, n) {
		var r = e.updateQueue;
		if (r === null) return null;
		if (r = r.shared, G & 2) {
			var i = r.pending;
			return i === null ? t.next = t : (t.next = i.next, i.next = t), r.pending = t, t = Oi(e), Di(e, null, n), t;
		}
		return wi(e, r, t, n), Oi(e);
	}
	function _o(e, t, n) {
		if (t = t.updateQueue, t !== null && (t = t.shared, n & 4194048)) {
			var r = t.lanes;
			r &= e.pendingLanes, n |= r, t.lanes = n, ht(e, n);
		}
	}
	function vo(e, t) {
		var n = e.updateQueue, r = e.alternate;
		if (r !== null && (r = r.updateQueue, n === r)) {
			var i = null, a = null;
			if (n = n.firstBaseUpdate, n !== null) {
				do {
					var o = {
						lane: n.lane,
						tag: n.tag,
						payload: n.payload,
						callback: null,
						next: null
					};
					a === null ? i = a = o : a = a.next = o, n = n.next;
				} while (n !== null);
				a === null ? i = a = t : a = a.next = t;
			} else i = a = t;
			n = {
				baseState: r.baseState,
				firstBaseUpdate: i,
				lastBaseUpdate: a,
				shared: r.shared,
				callbacks: r.callbacks
			}, e.updateQueue = n;
			return;
		}
		e = n.lastBaseUpdate, e === null ? n.firstBaseUpdate = t : e.next = t, n.lastBaseUpdate = t;
	}
	var yo = !1;
	function bo() {
		if (yo) {
			var e = Ra;
			if (e !== null) throw e;
		}
	}
	function xo(e, t, n, r) {
		yo = !1;
		var i = e.updateQueue;
		fo = !1;
		var a = i.firstBaseUpdate, o = i.lastBaseUpdate, s = i.shared.pending;
		if (s !== null) {
			i.shared.pending = null;
			var c = s, l = c.next;
			c.next = null, o === null ? a = l : o.next = l, o = c;
			var u = e.alternate;
			u !== null && (u = u.updateQueue, s = u.lastBaseUpdate, s !== o && (s === null ? u.firstBaseUpdate = l : s.next = l, u.lastBaseUpdate = c));
		}
		if (a !== null) {
			var d = i.baseState;
			o = 0, u = l = c = null, s = a;
			do {
				var f = s.lane & -536870913, p = f !== s.lane;
				if (p ? (q & f) === f : (r & f) === f) {
					f !== 0 && f === La && (yo = !0), u !== null && (u = u.next = {
						lane: 0,
						tag: s.tag,
						payload: s.payload,
						callback: null,
						next: null
					});
					a: {
						var m = e, h = s;
						f = t;
						var g = n;
						switch (h.tag) {
							case 1:
								if (m = h.payload, typeof m == "function") {
									d = m.call(g, d, f);
									break a;
								}
								d = m;
								break a;
							case 3: m.flags = m.flags & -65537 | 128;
							case 0:
								if (m = h.payload, f = typeof m == "function" ? m.call(g, d, f) : m, f == null) break a;
								d = D({}, d, f);
								break a;
							case 2: fo = !0;
						}
					}
					f = s.callback, f !== null && (e.flags |= 64, p && (e.flags |= 8192), p = i.callbacks, p === null ? i.callbacks = [f] : p.push(f));
				} else p = {
					lane: f,
					tag: s.tag,
					payload: s.payload,
					callback: s.callback,
					next: null
				}, u === null ? (l = u = p, c = d) : u = u.next = p, o |= f;
				if (s = s.next, s === null) {
					if (s = i.shared.pending, s === null) break;
					p = s, s = p.next, p.next = null, i.lastBaseUpdate = p, i.shared.pending = null;
				}
			} while (1);
			u === null && (c = d), i.baseState = c, i.firstBaseUpdate = l, i.lastBaseUpdate = u, a === null && (i.shared.lanes = 0), ld |= o, e.lanes = o, e.memoizedState = d;
		}
	}
	function So(e, t) {
		if (typeof e != "function") throw Error(i(191, e));
		e.call(t);
	}
	function Co(e, t) {
		var n = e.callbacks;
		if (n !== null) for (e.callbacks = null, e = 0; e < n.length; e++) So(n[e], t);
	}
	var wo = ye(null), To = ye(0);
	function Eo(e, t) {
		e = sd, xe(To, e), xe(wo, t), sd = e | t.baseLanes;
	}
	function Do() {
		xe(To, sd), xe(wo, wo.current);
	}
	function Oo() {
		sd = To.current, be(wo), be(To);
	}
	var ko = ye(null), Ao = null;
	function jo(e) {
		var t = e.alternate;
		xe(Io, Io.current & 1), xe(ko, e), Ao === null && (t === null || wo.current !== null || t.memoizedState !== null) && (Ao = e);
	}
	function Mo(e) {
		xe(Io, Io.current), xe(ko, e), Ao === null && (Ao = e);
	}
	function No(e) {
		e.tag === 22 ? (xe(Io, Io.current), xe(ko, e), Ao === null && (Ao = e)) : Po();
	}
	function Po() {
		xe(Io, Io.current), xe(ko, ko.current);
	}
	function Fo(e) {
		be(ko), Ao === e && (Ao = null), be(Io);
	}
	var Io = ye(0);
	function Lo(e, t) {
		xe(ko, ko.current), xe(Io, t);
	}
	function Ro(e) {
		be(Io), be(ko), Ao === e && (Ao = null);
	}
	function zo(e) {
		for (var t = e; t !== null;) {
			if (t.tag === 13) {
				var n = t.memoizedState;
				if (n !== null && (n = n.dehydrated, n === null || dm(n) || fm(n))) return t;
			} else if (t.tag === 19 && t.memoizedProps.revealOrder !== "independent") {
				if (t.flags & 128) return t;
			} else if (t.child !== null) {
				t.child.return = t, t = t.child;
				continue;
			}
			if (t === e) break;
			for (; t.sibling === null;) {
				if (t.return === null || t.return === e) return null;
				t = t.return;
			}
			t.sibling.return = t.return, t = t.sibling;
		}
		return null;
	}
	var Bo = 0, U = null, Vo = null, Ho = null, Uo = !1, Wo = !1, Go = !1, Ko = 0, qo = 0, Jo = null, Yo = 0;
	function Xo() {
		throw Error(i(321));
	}
	function Zo(e, t) {
		if (t === null) return !1;
		for (var n = 0; n < t.length && n < e.length; n++) if (!Vr(e[n], t[n])) return !1;
		return !0;
	}
	function Qo(e, t, n, r, i, a) {
		return Bo = a, U = t, t.memoizedState = null, t.updateQueue = null, t.lanes = 0, F.H = e === null || e.memoizedState === null ? hc : gc, Go = !1, a = n(r, i), Go = !1, Wo && (a = es(t, n, r, i)), $o(e), a;
	}
	function $o(e) {
		F.H = mc;
		var t = Vo !== null && Vo.next !== null;
		if (Bo = 0, Ho = Vo = U = null, Uo = !1, qo = 0, Jo = null, t) throw Error(i(300));
		e === null || Nc || (e = e.dependencies, e !== null && Sa(e) && (Nc = !0));
	}
	function es(e, t, n, r) {
		U = e;
		var a = 0;
		do {
			if (Wo && (Jo = null), qo = 0, Wo = !1, 25 <= a) throw Error(i(301));
			if (a += 1, Ho = Vo = null, e.updateQueue != null) {
				var o = e.updateQueue;
				o.lastEffect = null, o.events = null, o.stores = null, o.memoCache != null && (o.memoCache.index = 0);
			}
			F.H = _c, o = t(n, r);
		} while (Wo);
		return o;
	}
	function ts() {
		var e = F.H, t = e.useState()[0];
		return t = typeof t.then == "function" ? cs(t) : t, e = e.useState()[0], (Vo === null ? null : Vo.memoizedState) !== e && (U.flags |= 1024), t;
	}
	function ns() {
		var e = Ko !== 0;
		return Ko = 0, e;
	}
	function rs(e, t, n) {
		t.updateQueue = e.updateQueue, t.flags &= -2053, e.lanes &= ~n;
	}
	function is(e) {
		if (Uo) {
			for (e = e.memoizedState; e !== null;) {
				var t = e.queue;
				t !== null && (t.pending = null), e = e.next;
			}
			Uo = !1;
		}
		Bo = 0, Ho = Vo = U = null, Wo = !1, qo = Ko = 0, Jo = null;
	}
	function as() {
		var e = {
			memoizedState: null,
			baseState: null,
			baseQueue: null,
			queue: null,
			next: null
		};
		return Ho === null ? U.memoizedState = Ho = e : Ho = Ho.next = e, Ho;
	}
	function os() {
		if (Vo === null) {
			var e = U.alternate;
			e = e === null ? null : e.memoizedState;
		} else e = Vo.next;
		var t = Ho === null ? U.memoizedState : Ho.next;
		if (t !== null) Ho = t, Vo = e;
		else {
			if (e === null) throw U.alternate === null ? Error(i(467)) : Error(i(310));
			Vo = e, e = {
				memoizedState: Vo.memoizedState,
				baseState: Vo.baseState,
				baseQueue: Vo.baseQueue,
				queue: Vo.queue,
				next: null
			}, Ho === null ? U.memoizedState = Ho = e : Ho = Ho.next = e;
		}
		return Ho;
	}
	function ss() {
		return {
			lastEffect: null,
			events: null,
			stores: null,
			memoCache: null
		};
	}
	function cs(e) {
		var t = qo;
		return qo += 1, Jo === null && (Jo = []), e = Qa(Jo, e, t), t = U, (Ho === null ? t.memoizedState : Ho.next) === null && (t = t.alternate, F.H = t === null || t.memoizedState === null ? hc : gc), e;
	}
	function ls(e) {
		if (typeof e == "object" && e) {
			if (typeof e.then == "function") return cs(e);
			if (e.$$typeof === ue) return;
			if (e.$$typeof === M) return Ca(e);
		}
		throw Error(i(438, String(e)));
	}
	function us(e) {
		var t = null, n = U.updateQueue;
		if (n !== null && (t = n.memoCache), t == null) {
			var r = U.alternate;
			r !== null && (r = r.updateQueue, r !== null && (r = r.memoCache, r != null && (t = {
				data: r.data.map(function(e) {
					return e.slice();
				}),
				index: 0
			})));
		}
		if (t ??= {
			data: [],
			index: 0
		}, n === null && (n = ss(), U.updateQueue = n), n.memoCache = t, n = t.data[t.index], n === void 0) for (n = t.data[t.index] = Array(e), r = 0; r < e; r++) n[r] = ce;
		return t.index++, n;
	}
	function ds(e, t) {
		return typeof t == "function" ? t(e) : t;
	}
	function fs(e) {
		return ps(os(), Vo, e);
	}
	function ps(e, t, n) {
		var r = e.queue;
		if (r === null) throw Error(i(311));
		r.lastRenderedReducer = n;
		var a = e.baseQueue, o = r.pending;
		if (o !== null) {
			if (a !== null) {
				var s = a.next;
				a.next = o.next, o.next = s;
			}
			t.baseQueue = a = o, r.pending = null;
		}
		if (o = e.baseState, a === null) e.memoizedState = o;
		else {
			t = a.next;
			var c = s = null, l = null, u = t, d = !1;
			do {
				var f = u.lane & -536870913;
				if (f === u.lane ? (Bo & f) === f : (q & f) === f) {
					var p = u.revertLane;
					if (p === 0) l !== null && (l = l.next = {
						lane: 0,
						revertLane: 0,
						gesture: null,
						action: u.action,
						hasEagerState: u.hasEagerState,
						eagerState: u.eagerState,
						next: null
					}), f === La && (d = !0);
					else if ((Bo & p) === p) {
						u = u.next, p === La && (d = !0);
						continue;
					} else f = {
						lane: 0,
						revertLane: u.revertLane,
						gesture: null,
						action: u.action,
						hasEagerState: u.hasEagerState,
						eagerState: u.eagerState,
						next: null
					}, l === null ? (c = l = f, s = o) : l = l.next = f, U.lanes |= p, ld |= p;
					f = u.action, Go && n(o, f), o = u.hasEagerState ? u.eagerState : n(o, f);
				} else p = {
					lane: f,
					revertLane: u.revertLane,
					gesture: u.gesture,
					action: u.action,
					hasEagerState: u.hasEagerState,
					eagerState: u.eagerState,
					next: null
				}, l === null ? (c = l = p, s = o) : l = l.next = p, U.lanes |= f, ld |= f;
				u = u.next;
			} while (u !== null && u !== t);
			if (l === null ? s = o : l.next = c, !Vr(o, e.memoizedState) && (Nc = !0, d && (n = Ra, n !== null))) throw n;
			e.memoizedState = o, e.baseState = s, e.baseQueue = l, r.lastRenderedState = o;
		}
		return a === null && (r.lanes = 0), [e.memoizedState, r.dispatch];
	}
	function ms(e) {
		var t = os(), n = t.queue;
		if (n === null) throw Error(i(311));
		n.lastRenderedReducer = e;
		var r = n.dispatch, a = n.pending, o = t.memoizedState;
		if (a !== null) {
			n.pending = null;
			var s = a = a.next;
			do
				o = e(o, s.action), s = s.next;
			while (s !== a);
			Vr(o, t.memoizedState) || (Nc = !0), t.memoizedState = o, t.baseQueue === null && (t.baseState = o), n.lastRenderedState = o;
		}
		return [o, r];
	}
	function hs(e, t, n) {
		var r = U, a = os(), o = V;
		if (o) {
			if (n === void 0) throw Error(i(407));
			n = n();
		} else n = t();
		var s = !Vr((Vo || a).memoizedState, n);
		if (s && (a.memoizedState = n, Nc = !0), a = a.queue, Bs(vs.bind(null, r, a, e), [e]), e = a.getSnapshot !== t || s || Ho !== null && !!(Ho.memoizedState.tag & 1), Fs(e ? 9 : 8, { destroy: void 0 }, _s.bind(null, r, a, n, t), null), e) {
			if (r.flags |= 2048, td === null) throw Error(i(349));
			o || Bo & 127 || gs(r, t, n);
		}
		return n;
	}
	function gs(e, t, n) {
		e.flags |= 16384, e = {
			getSnapshot: t,
			value: n
		}, t = U.updateQueue, t === null ? (t = ss(), U.updateQueue = t, t.stores = [e]) : (n = t.stores, n === null ? t.stores = [e] : n.push(e));
	}
	function _s(e, t, n, r) {
		t.value = n, t.getSnapshot = r, ys(t) && bs(e);
	}
	function vs(e, t, n) {
		return n(function() {
			ys(t) && bs(e);
		});
	}
	function ys(e) {
		var t = e.getSnapshot;
		e = e.value;
		try {
			var n = t();
			return !Vr(e, n);
		} catch {
			return !0;
		}
	}
	function bs(e) {
		var t = Ei(e, 2);
		t !== null && Ld(t, e, 2);
	}
	function xs(e) {
		var t = as();
		if (typeof e == "function") {
			var n = e;
			if (e = n(), Go) {
				Qe(!0);
				try {
					n();
				} finally {
					Qe(!1);
				}
			}
		}
		return t.memoizedState = t.baseState = e, t.queue = {
			pending: null,
			lanes: 0,
			dispatch: null,
			lastRenderedReducer: ds,
			lastRenderedState: e
		}, t;
	}
	function Ss(e, t, n, r) {
		return e.baseState = n, ps(e, Vo, typeof r == "function" ? r : ds);
	}
	function Cs(e, t, n, r, a) {
		if (dc(e)) throw Error(i(485));
		if (e = t.action, e !== null) {
			var o = {
				payload: a,
				action: e,
				next: null,
				isTransition: !0,
				status: "pending",
				value: null,
				reason: null,
				listeners: [],
				then: function(e) {
					o.listeners.push(e);
				}
			};
			F.T === null ? o.isTransition = !1 : n(!0), r(o), n = t.pending, n === null ? (o.next = t.pending = o, ws(t, o)) : (o.next = n.next, t.pending = n.next = o);
		}
	}
	function ws(e, t) {
		var n = t.action, r = t.payload, i = e.state;
		if (t.isTransition) {
			var a = F.T, o = {};
			o.types = a === null ? null : a.types, F.T = o;
			try {
				var s = n(i, r), c = F.S;
				c !== null && c(o, s), Ts(e, t, s);
			} catch (n) {
				Ds(e, t, n);
			} finally {
				a !== null && o.types !== null && (a.types = o.types), F.T = a;
			}
		} else try {
			a = n(i, r), Ts(e, t, a);
		} catch (n) {
			Ds(e, t, n);
		}
	}
	function Ts(e, t, n) {
		typeof n == "object" && n && typeof n.then == "function" ? n.then(function(n) {
			Es(e, t, n);
		}, function(n) {
			return Ds(e, t, n);
		}) : Es(e, t, n);
	}
	function Es(e, t, n) {
		t.status = "fulfilled", t.value = n, Os(t), e.state = n, t = e.pending, t !== null && (n = t.next, n === t ? e.pending = null : (n = n.next, t.next = n, ws(e, n)));
	}
	function Ds(e, t, n) {
		var r = e.pending;
		if (e.pending = null, r !== null) {
			r = r.next;
			do
				t.status = "rejected", t.reason = n, Os(t), t = t.next;
			while (t !== r);
		}
		e.action = null;
	}
	function Os(e) {
		e = e.listeners;
		for (var t = 0; t < e.length; t++) (0, e[t])();
	}
	function ks(e, t) {
		return t;
	}
	function As(e, t) {
		if (V) {
			var n = td.formState;
			if (n !== null) {
				a: {
					var r = U;
					if (V) {
						if (ra) {
							b: {
								for (var i = ra, a = aa; i.nodeType !== 8;) {
									if (!a) {
										i = null;
										break b;
									}
									if (i = mm(i.nextSibling), i === null) {
										i = null;
										break b;
									}
								}
								a = i.data, i = a === "F!" || a === "F" ? i : null;
							}
							if (i) {
								ra = mm(i.nextSibling), r = i.data === "F!";
								break a;
							}
						}
						sa(r);
					}
					r = !1;
				}
				r && (t = n[0]);
			}
		}
		return n = as(), n.memoizedState = n.baseState = t, r = {
			pending: null,
			lanes: 0,
			dispatch: null,
			lastRenderedReducer: ks,
			lastRenderedState: t
		}, n.queue = r, n = cc.bind(null, U, r), r.dispatch = n, r = xs(!1), a = uc.bind(null, U, !1, r.queue), r = as(), i = {
			state: t,
			dispatch: null,
			action: e,
			pending: null
		}, r.queue = i, n = Cs.bind(null, U, i, a, n), i.dispatch = n, r.memoizedState = e, [
			t,
			n,
			!1
		];
	}
	function js(e) {
		return Ms(os(), Vo, e);
	}
	function Ms(e, t, n) {
		if (t = ps(e, t, ks)[0], e = fs(ds)[0], typeof t == "object" && t && typeof t.then == "function") try {
			var r = cs(t);
		} catch (e) {
			throw e === qa ? Ya : e;
		}
		else r = t;
		t = os();
		var i = t.queue, a = i.dispatch;
		return n !== t.memoizedState && (U.flags |= 2048, Fs(9, { destroy: void 0 }, Ns.bind(null, i, n), null)), [
			r,
			a,
			e
		];
	}
	function Ns(e, t) {
		e.action = t;
	}
	function Ps(e) {
		var t = os(), n = Vo;
		if (n !== null) return Ms(t, n, e);
		os(), t = t.memoizedState, n = os();
		var r = n.queue.dispatch;
		return n.memoizedState = e, [
			t,
			r,
			!1
		];
	}
	function Fs(e, t, n, r) {
		return e = {
			tag: e,
			create: n,
			deps: r,
			inst: t,
			next: null
		}, t = U.updateQueue, t === null && (t = ss(), U.updateQueue = t), n = t.lastEffect, n === null ? t.lastEffect = e.next = e : (r = n.next, n.next = e, e.next = r, t.lastEffect = e), e;
	}
	function Is() {
		return os().memoizedState;
	}
	function Ls(e, t, n, r) {
		var i = as();
		U.flags |= e, i.memoizedState = Fs(1 | t, { destroy: void 0 }, n, r === void 0 ? null : r);
	}
	function Rs(e, t, n, r) {
		var i = os();
		r = r === void 0 ? null : r;
		var a = i.memoizedState.inst;
		Vo !== null && r !== null && Zo(r, Vo.memoizedState.deps) ? i.memoizedState = Fs(t, a, n, r) : (U.flags |= e, i.memoizedState = Fs(1 | t, a, n, r));
	}
	function zs(e, t) {
		Ls(8390656, 8, e, t);
	}
	function Bs(e, t) {
		Rs(2048, 8, e, t);
	}
	function Vs(e) {
		U.flags |= 4;
		var t = U.updateQueue;
		if (t === null) t = ss(), U.updateQueue = t, t.events = [e];
		else {
			var n = t.events;
			n === null ? t.events = [e] : n.push(e);
		}
	}
	function Hs(e) {
		var t = os().memoizedState;
		return Vs({
			ref: t,
			nextImpl: e
		}), function() {
			if (G & 2) throw Error(i(440));
			return t.impl.apply(void 0, arguments);
		};
	}
	function Us(e, t) {
		return Rs(4, 2, e, t);
	}
	function Ws(e, t) {
		return Rs(4, 4, e, t);
	}
	function Gs(e, t) {
		if (typeof t == "function") {
			e = e();
			var n = t(e);
			return function() {
				typeof n == "function" ? n() : t(null);
			};
		}
		if (t != null) return e = e(), t.current = e, function() {
			t.current = null;
		};
	}
	function Ks(e, t, n) {
		n = n == null ? null : n.concat([e]), Rs(4, 4, Gs.bind(null, t, e), n);
	}
	function qs() {}
	function Js(e, t) {
		var n = os();
		t = t === void 0 ? null : t;
		var r = n.memoizedState;
		return t !== null && Zo(t, r[1]) ? r[0] : (n.memoizedState = [e, t], e);
	}
	function Ys(e, t) {
		var n = os();
		t = t === void 0 ? null : t;
		var r = n.memoizedState;
		if (t !== null && Zo(t, r[1])) return r[0];
		if (r = e(), Go) {
			Qe(!0);
			try {
				e();
			} finally {
				Qe(!1);
			}
		}
		return n.memoizedState = [r, t], r;
	}
	function Xs(e, t, n) {
		return n === void 0 || Bo & 1073741824 && !(q & 261930) ? e.memoizedState = t : (e.memoizedState = n, e = Fd(), U.lanes |= e, ld |= e, n);
	}
	function Zs(e, t, n, r) {
		return Vr(n, t) ? n : wo.current === null ? !(Bo & 106) || Bo & 1073741824 && !(q & 261930) ? (Nc = !0, e.memoizedState = n) : (e = Fd(), U.lanes |= e, ld |= e, t) : (e = Xs(e, n, r), Vr(e, t) || (Nc = !0), e);
	}
	function Qs(e, t, n, r, i) {
		var a = I.p;
		I.p = a !== 0 && 8 > a ? a : 8;
		var o = F.T, s = {};
		s.types = o === null ? null : o.types, F.T = s, uc(e, !1, t, n);
		try {
			var c = i(), l = F.S;
			l !== null && l(s, c), typeof c == "object" && c && typeof c.then == "function" ? lc(e, t, Va(c, r), Pd(e)) : lc(e, t, r, Pd(e));
		} catch (n) {
			lc(e, t, {
				then: function() {},
				status: "rejected",
				reason: n
			}, Pd());
		} finally {
			I.p = a, o !== null && s.types !== null && (o.types = s.types), F.T = o;
		}
	}
	function $s() {}
	function ec(e, t, n, r) {
		if (e.tag !== 5) throw Error(i(476));
		var a = tc(e).queue;
		Qs(e, a, t, ge, n === null ? $s : function() {
			return nc(e), n(r);
		});
	}
	function tc(e) {
		var t = e.memoizedState;
		if (t !== null) return t;
		t = {
			memoizedState: ge,
			baseState: ge,
			baseQueue: null,
			queue: {
				pending: null,
				lanes: 0,
				dispatch: null,
				lastRenderedReducer: ds,
				lastRenderedState: ge
			},
			next: null
		};
		var n = {};
		return t.next = {
			memoizedState: n,
			baseState: n,
			baseQueue: null,
			queue: {
				pending: null,
				lanes: 0,
				dispatch: null,
				lastRenderedReducer: ds,
				lastRenderedState: n
			},
			next: null
		}, e.memoizedState = t, e = e.alternate, e !== null && (e.memoizedState = t), t;
	}
	function nc(e) {
		var t = tc(e);
		t.next === null && (t = e.alternate.memoizedState), lc(e, t.next.queue, {}, Pd());
	}
	function rc() {
		return Ca(uh);
	}
	function ic() {
		return os().memoizedState;
	}
	function ac() {
		return os().memoizedState;
	}
	function oc(e) {
		for (var t = e.return; t !== null;) {
			switch (t.tag) {
				case 24:
				case 3:
					var n = Pd();
					e = ho(n);
					var r = go(t, e, n);
					r !== null && (Ld(r, t, n), _o(r, t, n)), t = { cache: Aa() }, e.payload = t;
					return;
			}
			t = t.return;
		}
	}
	function sc(e, t, n) {
		var r = Pd();
		n = {
			lane: r,
			revertLane: 0,
			gesture: null,
			action: n,
			hasEagerState: !1,
			eagerState: null,
			next: null
		}, dc(e) ? fc(t, n) : (n = Ti(e, t, n, r), n !== null && (Ld(n, e, r), pc(n, t, r)));
	}
	function cc(e, t, n) {
		lc(e, t, n, Pd());
	}
	function lc(e, t, n, r) {
		var i = {
			lane: r,
			revertLane: 0,
			gesture: null,
			action: n,
			hasEagerState: !1,
			eagerState: null,
			next: null
		};
		if (dc(e)) fc(t, i);
		else {
			var a = e.alternate;
			if (e.lanes === 0 && (a === null || a.lanes === 0) && (a = t.lastRenderedReducer, a !== null)) try {
				var o = t.lastRenderedState, s = a(o, n);
				if (i.hasEagerState = !0, i.eagerState = s, Vr(s, o)) return wi(e, t, i, 0), td === null && Ci(), !1;
			} catch {}
			if (n = Ti(e, t, i, r), n !== null) return Ld(n, e, r), pc(n, t, r), !0;
		}
		return !1;
	}
	function uc(e, t, n, r) {
		if (r = {
			lane: 2,
			revertLane: Rf(),
			gesture: null,
			action: r,
			hasEagerState: !1,
			eagerState: null,
			next: null
		}, dc(e)) {
			if (t) throw Error(i(479));
		} else t = Ti(e, n, r, 2), t !== null && Ld(t, e, 2);
	}
	function dc(e) {
		var t = e.alternate;
		return e === U || t !== null && t === U;
	}
	function fc(e, t) {
		Wo = Uo = !0;
		var n = e.pending;
		n === null ? t.next = t : (t.next = n.next, n.next = t), e.pending = t;
	}
	function pc(e, t, n) {
		if (n & 4194048) {
			var r = t.lanes;
			r &= e.pendingLanes, n |= r, t.lanes = n, ht(e, n);
		}
	}
	var mc = {
		readContext: Ca,
		use: ls,
		useCallback: Xo,
		useContext: Xo,
		useEffect: Xo,
		useImperativeHandle: Xo,
		useLayoutEffect: Xo,
		useInsertionEffect: Xo,
		useMemo: Xo,
		useReducer: Xo,
		useRef: Xo,
		useState: Xo,
		useDebugValue: Xo,
		useDeferredValue: Xo,
		useTransition: Xo,
		useSyncExternalStore: Xo,
		useId: Xo,
		useHostTransitionStatus: Xo,
		useFormState: Xo,
		useActionState: Xo,
		useOptimistic: Xo,
		useMemoCache: Xo,
		useCacheRefresh: Xo,
		useEffectEvent: Xo
	}, hc = {
		readContext: Ca,
		use: ls,
		useCallback: function(e, t) {
			return as().memoizedState = [e, t === void 0 ? null : t], e;
		},
		useContext: Ca,
		useEffect: zs,
		useImperativeHandle: function(e, t, n) {
			n = n == null ? null : n.concat([e]), Ls(4194308, 4, Gs.bind(null, t, e), n);
		},
		useLayoutEffect: function(e, t) {
			return Ls(4194308, 4, e, t);
		},
		useInsertionEffect: function(e, t) {
			Ls(4, 2, e, t);
		},
		useMemo: function(e, t) {
			var n = as();
			t = t === void 0 ? null : t;
			var r = e();
			if (Go) {
				Qe(!0);
				try {
					e();
				} finally {
					Qe(!1);
				}
			}
			return n.memoizedState = [r, t], r;
		},
		useReducer: function(e, t, n) {
			var r = as();
			if (n !== void 0) {
				var i = n(t);
				if (Go) {
					Qe(!0);
					try {
						n(t);
					} finally {
						Qe(!1);
					}
				}
			} else i = t;
			return r.memoizedState = r.baseState = i, e = {
				pending: null,
				lanes: 0,
				dispatch: null,
				lastRenderedReducer: e,
				lastRenderedState: i
			}, r.queue = e, e = e.dispatch = sc.bind(null, U, e), [r.memoizedState, e];
		},
		useRef: function(e) {
			var t = as();
			return e = { current: e }, t.memoizedState = e;
		},
		useState: function(e) {
			e = xs(e);
			var t = e.queue, n = cc.bind(null, U, t);
			return t.dispatch = n, [e.memoizedState, n];
		},
		useDebugValue: qs,
		useDeferredValue: function(e, t) {
			return Xs(as(), e, t);
		},
		useTransition: function() {
			var e = xs(!1);
			return e = Qs.bind(null, U, e.queue, !0, !1), as().memoizedState = e, [!1, e];
		},
		useSyncExternalStore: function(e, t, n) {
			var r = U, a = as();
			if (V) {
				if (n === void 0) throw Error(i(407));
				n = n();
			} else {
				if (n = t(), td === null) throw Error(i(349));
				q & 127 || gs(r, t, n);
			}
			a.memoizedState = n;
			var o = {
				value: n,
				getSnapshot: t
			};
			return a.queue = o, zs(vs.bind(null, r, o, e), [e]), r.flags |= 2048, Fs(9, { destroy: void 0 }, _s.bind(null, r, o, n, t), null), n;
		},
		useId: function() {
			var e = as(), t = td.identifierPrefix;
			if (V) {
				var n = Xi, r = Yi;
				n = (r & ~(1 << 32 - $e(r) - 1)).toString(32) + n, t = "_" + t + "R_" + n, n = Ko++, 0 < n && (t += "H" + n.toString(32)), t += "_";
			} else n = Yo++, t = "_" + t + "r_" + n.toString(32) + "_";
			return e.memoizedState = t;
		},
		useHostTransitionStatus: rc,
		useFormState: As,
		useActionState: As,
		useOptimistic: function(e) {
			var t = as();
			t.memoizedState = t.baseState = e;
			var n = {
				pending: null,
				lanes: 0,
				dispatch: null,
				lastRenderedReducer: null,
				lastRenderedState: null
			};
			return t.queue = n, t = uc.bind(null, U, !0, n), n.dispatch = t, [e, t];
		},
		useMemoCache: us,
		useCacheRefresh: function() {
			return as().memoizedState = oc.bind(null, U);
		},
		useEffectEvent: function(e) {
			var t = as(), n = { impl: e };
			return t.memoizedState = n, function() {
				if (G & 2) throw Error(i(440));
				return n.impl.apply(void 0, arguments);
			};
		}
	}, gc = {
		readContext: Ca,
		use: ls,
		useCallback: Js,
		useContext: Ca,
		useEffect: Bs,
		useImperativeHandle: Ks,
		useInsertionEffect: Us,
		useLayoutEffect: Ws,
		useMemo: Ys,
		useReducer: fs,
		useRef: Is,
		useState: function() {
			return fs(ds);
		},
		useDebugValue: qs,
		useDeferredValue: function(e, t) {
			return Zs(os(), Vo.memoizedState, e, t);
		},
		useTransition: function() {
			var e = fs(ds)[0], t = os().memoizedState;
			return [typeof e == "boolean" ? e : cs(e), t];
		},
		useSyncExternalStore: hs,
		useId: ic,
		useHostTransitionStatus: rc,
		useFormState: js,
		useActionState: js,
		useOptimistic: function(e, t) {
			return Ss(os(), Vo, e, t);
		},
		useMemoCache: us,
		useCacheRefresh: ac,
		useEffectEvent: Hs
	}, _c = {
		readContext: Ca,
		use: ls,
		useCallback: Js,
		useContext: Ca,
		useEffect: Bs,
		useImperativeHandle: Ks,
		useInsertionEffect: Us,
		useLayoutEffect: Ws,
		useMemo: Ys,
		useReducer: ms,
		useRef: Is,
		useState: function() {
			return ms(ds);
		},
		useDebugValue: qs,
		useDeferredValue: function(e, t) {
			var n = os();
			return Vo === null ? Xs(n, e, t) : Zs(n, Vo.memoizedState, e, t);
		},
		useTransition: function() {
			var e = ms(ds)[0], t = os().memoizedState;
			return [typeof e == "boolean" ? e : cs(e), t];
		},
		useSyncExternalStore: hs,
		useId: ic,
		useHostTransitionStatus: rc,
		useFormState: Ps,
		useActionState: Ps,
		useOptimistic: function(e, t) {
			var n = os();
			return Vo === null ? (n.baseState = e, [e, n.queue.dispatch]) : Ss(n, Vo, e, t);
		},
		useMemoCache: us,
		useCacheRefresh: ac,
		useEffectEvent: Hs
	};
	function vc(e, t, n, r) {
		t = e.memoizedState, n = n(r, t), n = n == null ? t : D({}, t, n), e.memoizedState = n, e.lanes === 0 && (e.updateQueue.baseState = n);
	}
	var yc = {
		enqueueSetState: function(e, t, n) {
			e = e._reactInternals;
			var r = Pd(), i = ho(r);
			i.payload = t, n != null && (i.callback = n), t = go(e, i, r), t !== null && (Ld(t, e, r), _o(t, e, r));
		},
		enqueueReplaceState: function(e, t, n) {
			e = e._reactInternals;
			var r = Pd(), i = ho(r);
			i.tag = 1, i.payload = t, n != null && (i.callback = n), t = go(e, i, r), t !== null && (Ld(t, e, r), _o(t, e, r));
		},
		enqueueForceUpdate: function(e, t) {
			e = e._reactInternals;
			var n = Pd(), r = ho(n);
			r.tag = 2, t != null && (r.callback = t), t = go(e, r, n), t !== null && (Ld(t, e, n), _o(t, e, n));
		}
	};
	function bc(e, t, n, r, i, a, o) {
		return e = e.stateNode, typeof e.shouldComponentUpdate == "function" ? e.shouldComponentUpdate(r, a, o) : t.prototype && t.prototype.isPureReactComponent ? !Hr(n, r) || !Hr(i, a) : !0;
	}
	function xc(e, t, n, r) {
		e = t.state, typeof t.componentWillReceiveProps == "function" && t.componentWillReceiveProps(n, r), typeof t.UNSAFE_componentWillReceiveProps == "function" && t.UNSAFE_componentWillReceiveProps(n, r), t.state !== e && yc.enqueueReplaceState(t, t.state, null);
	}
	function Sc(e, t) {
		var n = t;
		if ("ref" in t) for (var r in n = {}, t) r !== "ref" && (n[r] = t[r]);
		if (e = e.defaultProps) for (var i in n === t && (n = D({}, n)), e) n[i] === void 0 && (n[i] = e[i]);
		return n;
	}
	function Cc(e) {
		yi(e);
	}
	function wc(e) {
		console.error(e);
	}
	function Tc(e) {
		yi(e);
	}
	function Ec(e, t) {
		try {
			var n = e.onUncaughtError;
			n(t.value, { componentStack: t.stack });
		} catch (e) {
			setTimeout(function() {
				throw e;
			});
		}
	}
	function Dc(e, t, n) {
		try {
			var r = e.onCaughtError;
			r(n.value, {
				componentStack: n.stack,
				errorBoundary: t.tag === 1 ? t.stateNode : null
			});
		} catch (e) {
			setTimeout(function() {
				throw e;
			});
		}
	}
	function Oc(e, t, n) {
		return n = ho(n), n.tag = 3, n.payload = { element: null }, n.callback = function() {
			Ec(e, t);
		}, n;
	}
	function kc(e) {
		return e = ho(e), e.tag = 3, e;
	}
	function Ac(e, t, n, r) {
		var i = n.type.getDerivedStateFromError;
		if (typeof i == "function") {
			var a = r.value;
			e.payload = function() {
				return i(a);
			}, e.callback = function() {
				Dc(t, n, r);
			};
		}
		var o = n.stateNode;
		o !== null && typeof o.componentDidCatch == "function" && (e.callback = function() {
			Dc(t, n, r), typeof i != "function" && (xd === null ? xd = /* @__PURE__ */ new Set([this]) : xd.add(this));
			var e = r.stack;
			this.componentDidCatch(r.value, { componentStack: e === null ? "" : e });
		});
	}
	function jc(e, t, n, r, a) {
		if (n.flags |= 32768, typeof r == "object" && r && typeof r.then == "function") {
			if (t = n.alternate, t !== null && xa(t, n, a, !0), n = ko.current, n !== null) {
				switch (n.tag) {
					case 31:
					case 13:
					case 19: return Ao === null ? Yd() : n.alternate === null && cd === 0 && (cd = 3), n.flags &= -257, n.flags |= 65536, n.lanes = a, r === Xa ? n.flags |= 16384 : (t = n.updateQueue, t === null ? n.updateQueue = /* @__PURE__ */ new Set([r]) : t.add(r), vf(e, r, a)), !1;
					case 22: return n.flags |= 65536, r === Xa ? n.flags |= 16384 : (t = n.updateQueue, t === null ? (t = {
						transitions: null,
						markerInstances: null,
						retryQueue: /* @__PURE__ */ new Set([r])
					}, n.updateQueue = t) : (n = t.retryQueue, n === null ? t.retryQueue = /* @__PURE__ */ new Set([r]) : n.add(r)), vf(e, r, a)), !1;
				}
				throw Error(i(435, n.tag));
			}
			return vf(e, r, a), Yd(), !1;
		}
		if (V) return t = ko.current, t === null ? (r !== oa && (t = Error(i(423), { cause: r }), pa(Vi(t, n))), e = e.current.alternate, e.flags |= 65536, a &= -a, e.lanes |= a, r = Vi(r, n), a = Oc(e.stateNode, r, a), vo(e, a), cd !== 4 && (cd = 2)) : (!(t.flags & 65536) && (t.flags |= 256), t.flags |= 65536, t.lanes = a, r !== oa && (e = Error(i(422), { cause: r }), pa(Vi(e, n)))), !1;
		var o = Error(i(520), { cause: r });
		if (o = Vi(o, n), md === null ? md = [o] : md.push(o), cd !== 4 && (cd = 2), t === null) return !0;
		r = Vi(r, n), n = t;
		do {
			switch (n.tag) {
				case 3: return n.flags |= 65536, e = a & -a, n.lanes |= e, e = Oc(n.stateNode, r, e), vo(n, e), !1;
				case 1:
					if (t = n.type, o = n.stateNode, !(n.flags & 128) && (typeof t.getDerivedStateFromError == "function" || o !== null && typeof o.componentDidCatch == "function" && (xd === null || !xd.has(o)))) return n.flags |= 65536, a &= -a, n.lanes |= a, a = kc(a), Ac(a, e, n, r), vo(n, a), !1;
					break;
				case 22: if (n.memoizedState !== null) return n.flags |= 65536, !1;
			}
			n = n.return;
		} while (n !== null);
		return !1;
	}
	var Mc = Error(i(461)), Nc = !1;
	function Pc(e, t, n, r) {
		t.child = e === null ? uo(t, null, n, r) : lo(t, e.child, n, r);
	}
	function Fc(e, t, n, r, i) {
		n = n.render;
		var a = t.ref;
		if ("ref" in r) {
			var o = {};
			for (var s in r) s !== "ref" && (o[s] = r[s]);
		} else o = r;
		return H(t), r = Qo(e, t, n, o, a, i), s = ns(), e !== null && !Nc ? (rs(e, t, i), ll(e, t, i)) : (V && s && $i(t), t.flags |= 1, Pc(e, t, r, i), t.child);
	}
	function Ic(e, t, n, r, i) {
		if (e === null) {
			var a = n.type;
			return typeof a == "function" && !Mi(a) && a.defaultProps === void 0 && n.compare === null ? (t.tag = 15, t.type = a, Lc(e, t, a, r, i)) : (e = Fi(n.type, null, r, t, t.mode, i), e.ref = t.ref, e.return = t, t.child = e);
		}
		if (a = e.child, !ul(e, i)) {
			var o = a.memoizedProps;
			if (n = n.compare, n = n === null ? Hr : n, n(o, r) && e.ref === t.ref) return ll(e, t, i);
		}
		return t.flags |= 1, e = Ni(a, r), e.ref = t.ref, e.return = t, t.child = e;
	}
	function Lc(e, t, n, r, i) {
		if (e !== null) {
			var a = e.memoizedProps;
			if (Hr(a, r) && e.ref === t.ref) {
				if (Nc = !1, t.pendingProps = r = a, ul(e, i)) e.flags & 131072 && (Nc = !0);
				else return t.lanes = e.lanes, ll(e, t, i);
			}
		}
		return Gc(e, t, n, r, i);
	}
	function Rc(e, t, n, r) {
		var i = r.children, a = e === null ? null : e.memoizedState;
		if (e === null && t.stateNode === null && (t.stateNode = {
			_visibility: 1,
			_pendingMarkers: null,
			_retryCache: null,
			_transitions: null
		}), r.mode === "hidden") {
			if (t.flags & 128) {
				if (a = a === null ? n : a.baseLanes | n, e !== null) {
					for (r = t.child = e.child, i = 0; r !== null;) i = i | r.lanes | r.childLanes, r = r.sibling;
					r = i & ~a;
				} else r = 0, t.child = null;
				return Bc(e, t, a, n, r);
			}
			if (n & 536870912) t.memoizedState = {
				baseLanes: 0,
				cachePool: null
			}, e !== null && Ga(t, a === null ? null : a.cachePool), a === null ? Do() : Eo(t, a), No(t);
			else return r = t.lanes = 536870912, Bc(e, t, a === null ? n : a.baseLanes | n, n, r);
		} else a === null ? (e !== null && Ga(t, null), Do(), Po()) : (Ga(t, a.cachePool), Eo(t, a), Po(), t.memoizedState = null);
		return Pc(e, t, i, n), t.child;
	}
	function zc(e, t) {
		return e !== null && e.tag === 22 || t.stateNode !== null || (t.stateNode = {
			_visibility: 1,
			_pendingMarkers: null,
			_retryCache: null,
			_transitions: null
		}), t.sibling;
	}
	function Bc(e, t, n, r, i) {
		var a = Wa();
		return a = a === null ? null : {
			parent: ka._currentValue,
			pool: a
		}, t.memoizedState = {
			baseLanes: n,
			cachePool: a
		}, e !== null && Ga(t, null), Do(), No(t), e !== null && xa(e, t, r, !0), t.childLanes = i, null;
	}
	function Vc(e, t) {
		return t = el({
			mode: t.mode,
			children: t.children
		}, e.mode), t.ref = e.ref, e.child = t, t.return = e, t;
	}
	function Hc(e, t, n) {
		return lo(t, e.child, null, n), e = Vc(t, t.pendingProps), e.flags |= 2, Fo(t), t.memoizedState = null, e;
	}
	function Uc(e, t, n) {
		var r = t.pendingProps, a = !!(t.flags & 128);
		if (t.flags &= -129, e === null) {
			if (V) {
				if (r.mode === "hidden") return e = Vc(t, r), t.lanes = 536870912, e.memoizedState = {
					baseLanes: 0,
					cachePool: null
				}, zc(null, e);
				if (Mo(t), (e = ra) ? (e = um(e, aa), e = e !== null && e.data === "&" ? e : null, e !== null && (t.memoizedState = {
					dehydrated: e,
					treeContext: Ji === null ? null : {
						id: Yi,
						overflow: Xi
					},
					retryLane: 536870912,
					hydrationErrors: null
				}, n = Ri(e), n.return = t, t.child = n, na = t, ra = null)) : e = null, e === null) throw sa(t);
				return t.lanes = 536870912, null;
			}
			return Vc(t, r);
		}
		var o = e.memoizedState;
		if (o !== null) {
			var s = o.dehydrated;
			if (Mo(t), a) {
				if (t.flags & 256) t.flags &= -257, t = Hc(e, t, n);
				else if (t.memoizedState !== null) t.child = e.child, t.flags |= 128, t = null;
				else throw Error(i(558));
			} else if (Nc || xa(e, t, n, !1), a = (n & e.childLanes) !== 0, Nc || a) {
				if (wo.current === null) {
					if (r = td, r !== null && (s = gt(r, n), s !== 0 && s !== o.retryLane)) throw o.retryLane = s, Ei(e, s), Ld(r, e, s), Mc;
					Yd();
				}
				t = Hc(e, t, n);
			} else e = o.treeContext, ra = mm(s.nextSibling), na = t, V = !0, ia = null, aa = !1, e !== null && ta(t, e), t = Vc(t, r), t.flags |= 134221824;
			return t;
		}
		return e = Ni(e.child, {
			mode: r.mode,
			children: r.children
		}), e.ref = t.ref, t.child = e, e.return = t, e;
	}
	function Wc(e, t) {
		var n = t.ref;
		if (n === null) e !== null && e.ref !== null && (t.flags |= 4194816);
		else {
			if (typeof n != "function" && typeof n != "object") throw Error(i(284));
			(e === null || e.ref !== n) && (t.flags |= 4194816);
		}
	}
	function Gc(e, t, n, r, i) {
		return H(t), n = Qo(e, t, n, r, void 0, i), r = ns(), e !== null && !Nc ? (rs(e, t, i), ll(e, t, i)) : (V && r && $i(t), t.flags |= 1, Pc(e, t, n, i), t.child);
	}
	function Kc(e, t, n, r, i, a) {
		return H(t), t.updateQueue = null, n = es(t, r, n, i), $o(e), r = ns(), e !== null && !Nc ? (rs(e, t, a), ll(e, t, a)) : (V && r && $i(t), t.flags |= 1, Pc(e, t, n, a), t.child);
	}
	function qc(e, t, n, r, i) {
		if (H(t), t.stateNode === null) {
			var a = ki, o = n.contextType;
			typeof o == "object" && o && (a = Ca(o)), a = new n(r, a), t.memoizedState = a.state !== null && a.state !== void 0 ? a.state : null, a.updater = yc, t.stateNode = a, a._reactInternals = t, a = t.stateNode, a.props = r, a.state = t.memoizedState, a.refs = {}, po(t), o = n.contextType, a.context = typeof o == "object" && o ? Ca(o) : ki, a.state = t.memoizedState, o = n.getDerivedStateFromProps, typeof o == "function" && (vc(t, n, o, r), a.state = t.memoizedState), typeof n.getDerivedStateFromProps == "function" || typeof a.getSnapshotBeforeUpdate == "function" || typeof a.UNSAFE_componentWillMount != "function" && typeof a.componentWillMount != "function" || (o = a.state, typeof a.componentWillMount == "function" && a.componentWillMount(), typeof a.UNSAFE_componentWillMount == "function" && a.UNSAFE_componentWillMount(), o !== a.state && yc.enqueueReplaceState(a, a.state, null), xo(t, r, a, i), bo(), a.state = t.memoizedState), typeof a.componentDidMount == "function" && (t.flags |= 4194308), r = !0;
		} else if (e === null) {
			a = t.stateNode;
			var s = t.memoizedProps, c = Sc(n, s);
			a.props = c;
			var l = a.context, u = n.contextType;
			o = ki, typeof u == "object" && u && (o = Ca(u));
			var d = n.getDerivedStateFromProps;
			u = typeof d == "function" || typeof a.getSnapshotBeforeUpdate == "function", s = t.pendingProps !== s, u || typeof a.UNSAFE_componentWillReceiveProps != "function" && typeof a.componentWillReceiveProps != "function" || (s || l !== o) && xc(t, a, r, o), fo = !1;
			var f = t.memoizedState;
			a.state = f, xo(t, r, a, i), bo(), l = t.memoizedState, s || f !== l || fo ? (typeof d == "function" && (vc(t, n, d, r), l = t.memoizedState), (c = fo || bc(t, n, c, r, f, l, o)) ? (u || typeof a.UNSAFE_componentWillMount != "function" && typeof a.componentWillMount != "function" || (typeof a.componentWillMount == "function" && a.componentWillMount(), typeof a.UNSAFE_componentWillMount == "function" && a.UNSAFE_componentWillMount()), typeof a.componentDidMount == "function" && (t.flags |= 4194308)) : (typeof a.componentDidMount == "function" && (t.flags |= 4194308), t.memoizedProps = r, t.memoizedState = l), a.props = r, a.state = l, a.context = o, r = c) : (typeof a.componentDidMount == "function" && (t.flags |= 4194308), r = !1);
		} else {
			a = t.stateNode, mo(e, t), o = t.memoizedProps, u = Sc(n, o), a.props = u, d = t.pendingProps, f = a.context, l = n.contextType, c = ki, typeof l == "object" && l && (c = Ca(l)), s = n.getDerivedStateFromProps, (l = typeof s == "function" || typeof a.getSnapshotBeforeUpdate == "function") || typeof a.UNSAFE_componentWillReceiveProps != "function" && typeof a.componentWillReceiveProps != "function" || (o !== d || f !== c) && xc(t, a, r, c), fo = !1, f = t.memoizedState, a.state = f, xo(t, r, a, i), bo();
			var p = t.memoizedState;
			o !== d || f !== p || fo || e !== null && e.dependencies !== null && Sa(e.dependencies) ? (typeof s == "function" && (vc(t, n, s, r), p = t.memoizedState), (u = fo || bc(t, n, u, r, f, p, c) || e !== null && e.dependencies !== null && Sa(e.dependencies)) ? (l || typeof a.UNSAFE_componentWillUpdate != "function" && typeof a.componentWillUpdate != "function" || (typeof a.componentWillUpdate == "function" && a.componentWillUpdate(r, p, c), typeof a.UNSAFE_componentWillUpdate == "function" && a.UNSAFE_componentWillUpdate(r, p, c)), typeof a.componentDidUpdate == "function" && (t.flags |= 4), typeof a.getSnapshotBeforeUpdate == "function" && (t.flags |= 1024)) : (typeof a.componentDidUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 4), typeof a.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 1024), t.memoizedProps = r, t.memoizedState = p), a.props = r, a.state = p, a.context = c, r = u) : (typeof a.componentDidUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 4), typeof a.getSnapshotBeforeUpdate != "function" || o === e.memoizedProps && f === e.memoizedState || (t.flags |= 1024), r = !1);
		}
		return a = r, Wc(e, t), r = !!(t.flags & 128), a || r ? (a = t.stateNode, n = r && typeof n.getDerivedStateFromError != "function" ? null : a.render(), t.flags |= 1, e !== null && r ? (t.child = lo(t, e.child, null, i), t.child = lo(t, null, n, i)) : Pc(e, t, n, i), t.memoizedState = a.state, e = t.child) : e = ll(e, t, i), e;
	}
	function Jc(e, t, n, r) {
		return da(), t.flags |= 256, Pc(e, t, n, r), t.child;
	}
	var Yc = {
		dehydrated: null,
		treeContext: null,
		retryLane: 0,
		hydrationErrors: null
	};
	function Xc(e) {
		return {
			baseLanes: e,
			cachePool: Ka()
		};
	}
	function Zc(e, t, n) {
		return e = e === null ? 0 : e.childLanes & ~n, t && (e |= fd), e;
	}
	function Qc(e, t, n) {
		var r = t.pendingProps, i = !1, a = !!(t.flags & 128), o;
		if ((o = a) || (o = e !== null && e.memoizedState === null ? !1 : !!(Io.current & 2)), o && (i = !0, t.flags &= -129), o = !!(t.flags & 32), t.flags &= -33, e === null) {
			if (V) {
				if (i ? jo(t) : Po(), (e = ra) ? (e = um(e, aa), e = e !== null && e.data !== "&" ? e : null, e !== null && (t.memoizedState = {
					dehydrated: e,
					treeContext: Ji === null ? null : {
						id: Yi,
						overflow: Xi
					},
					retryLane: 536870912,
					hydrationErrors: null
				}, n = Ri(e), n.return = t, t.child = n, na = t, ra = null)) : e = null, e === null) throw sa(t);
				return t.lanes = fm(e) ? 32 : 536870912, null;
			}
			return a = r.children, r = r.fallback, i ? (Po(), i = t.mode, a = el({
				mode: "hidden",
				children: a
			}, i), r = Ii(r, i, n, null), a.return = t, r.return = t, a.sibling = r, t.child = a, r = t.child, r.memoizedState = Xc(n), r.childLanes = Zc(e, o, n), t.memoizedState = Yc, zc(null, r)) : (jo(t), $c(t, a));
		}
		var s = e.memoizedState;
		if (s !== null) {
			var c = s.dehydrated;
			if (c !== null) return nl(e, t, a, o, r, c, s, n);
		}
		return i ? (Po(), i = r.fallback, a = t.mode, s = e.child, c = s.sibling, r = Ni(s, {
			mode: "hidden",
			children: r.children
		}), r.subtreeFlags = s.subtreeFlags & 1206910976, c === null ? (i = Ii(i, a, n, null), i.flags |= 2) : i = Ni(c, i), i.return = t, r.return = t, r.sibling = i, t.child = r, zc(null, r), r = t.child, i = e.child.memoizedState, i === null ? i = Xc(n) : (a = i.cachePool, a === null ? a = Ka() : (s = ka._currentValue, a = a.parent === s ? a : {
			parent: s,
			pool: s
		}), i = {
			baseLanes: i.baseLanes | n,
			cachePool: a
		}), r.memoizedState = i, r.childLanes = Zc(e, o, n), t.memoizedState = Yc, zc(e.child, r)) : (jo(t), n = e.child, e = n.sibling, n = Ni(n, {
			mode: "visible",
			children: r.children
		}), n.return = t, n.sibling = null, e !== null && (o = t.deletions, o === null ? (t.deletions = [e], t.flags |= 16) : o.push(e)), t.child = n, t.memoizedState = null, n);
	}
	function $c(e, t) {
		return t = el({
			mode: "visible",
			children: t
		}, e.mode), t.return = e, e.child = t;
	}
	function el(e, t) {
		return e = ji(22, e, null, t), e.lanes = 0, e;
	}
	function tl(e, t, n) {
		return lo(t, e.child, null, n), e = $c(t, t.pendingProps.children), e.flags |= 2, t.memoizedState = null, e;
	}
	function nl(e, t, n, r, a, o, s, c) {
		if (n) return t.flags & 256 ? (jo(t), t.flags &= -257, tl(e, t, c)) : t.memoizedState === null ? (Po(), o = a.fallback, s = t.mode, a = el({
			mode: "visible",
			children: a.children
		}, s), o = Ii(o, s, c, null), o.flags |= 2, a.return = t, o.return = t, a.sibling = o, t.child = a, lo(t, e.child, null, c), a = t.child, a.memoizedState = Xc(c), a.childLanes = Zc(e, r, c), t.memoizedState = Yc, zc(null, a)) : (Po(), t.child = e.child, t.flags |= 128, null);
		if (jo(t), fm(o)) {
			if (r = o.nextSibling && o.nextSibling.dataset, r) var l = r.dgst;
			return r = l, r !== "" && (a = Error(i(419)), a.stack = "", a.digest = r, pa({
				value: a,
				source: null,
				stack: null
			})), tl(e, t, c);
		}
		if (Nc || xa(e, t, c, !1), r = (c & e.childLanes) !== 0, Nc || r) {
			if (wo.current !== null) return tl(e, t, c);
			if (r = td, r !== null && (a = gt(r, c), a !== 0 && a !== s.retryLane)) throw s.retryLane = a, Ei(e, a), Ld(r, e, a), Mc;
			return dm(o) || Yd(), tl(e, t, c);
		}
		return dm(o) ? (t.flags |= 192, t.child = e.child, null) : (e = s.treeContext, ra = mm(o.nextSibling), na = t, V = !0, ia = null, aa = !1, e !== null && ta(t, e), t = $c(t, a.children), t.flags |= 134221824, t);
	}
	function rl(e, t, n) {
		e.lanes |= t;
		var r = e.alternate;
		r !== null && (r.lanes |= t), ya(e.return, t, n);
	}
	function il(e) {
		for (var t = null; e !== null;) {
			var n = e.alternate;
			n !== null && zo(n) === null && (t = e), e = e.sibling;
		}
		return t;
	}
	function al(e, t, n, r, i, a) {
		var o = e.memoizedState;
		o === null ? e.memoizedState = {
			isBackwards: t,
			rendering: null,
			renderingStartTime: 0,
			last: r,
			tail: n,
			tailMode: i,
			treeForkCount: a
		} : (o.isBackwards = t, o.rendering = null, o.renderingStartTime = 0, o.last = r, o.tail = n, o.tailMode = i, o.treeForkCount = a);
	}
	function ol(e) {
		var t = e.child;
		for (e.child = null; t !== null;) {
			var n = t.sibling;
			t.sibling = e.child, e.child = t, t = n;
		}
	}
	function sl(e, t, n) {
		var r = t.pendingProps, i = r.revealOrder, a = r.tail;
		r = r.children;
		var o = Io.current;
		if (t.flags & 128) return Lo(t, o), null;
		var s = !!(o & 2);
		if (s ? (o = o & 1 | 2, t.flags |= 128) : o &= 1, Lo(t, o), i === "backwards" && e !== null ? (ol(e), Pc(e, t, r, n), ol(e)) : Pc(e, t, r, n), r = V ? Gi : 0, !s && e !== null && e.flags & 128) a: for (e = t.child; e !== null;) {
			if (e.tag === 13) e.memoizedState !== null && rl(e, n, t);
			else if (e.tag === 19) rl(e, n, t);
			else if (e.child !== null) {
				e.child.return = e, e = e.child;
				continue;
			}
			if (e === t) break a;
			for (; e.sibling === null;) {
				if (e.return === null || e.return === t) break a;
				e = e.return;
			}
			e.sibling.return = e.return, e = e.sibling;
		}
		switch (i) {
			case "backwards":
				n = il(t.child), n === null ? (i = t.child, t.child = null) : (i = n.sibling, n.sibling = null, ol(t)), al(t, !0, i, null, a, r);
				break;
			case "unstable_legacy-backwards":
				for (n = null, i = t.child, t.child = null; i !== null;) {
					if (e = i.alternate, e !== null && zo(e) === null) {
						t.child = i;
						break;
					}
					e = i.sibling, i.sibling = n, n = i, i = e;
				}
				al(t, !0, n, null, a, r);
				break;
			case "together":
				al(t, !1, null, null, void 0, r);
				break;
			case "independent":
				t.memoizedState = null;
				break;
			default: n = il(t.child), n === null ? (i = t.child, t.child = null) : (i = n.sibling, n.sibling = null), al(t, !1, i, n, a, r);
		}
		return t.child;
	}
	function cl(e, t, n) {
		var r = t.pendingProps;
		return _a(t, t.type, r.value), Pc(e, t, r.children, n), t.child;
	}
	function ll(e, t, n) {
		if (e !== null && (t.dependencies = e.dependencies), ld |= t.lanes, (n & t.childLanes) === 0) {
			if (e !== null) {
				if (xa(e, t, n, !1), (n & t.childLanes) === 0) return null;
			} else return null;
		}
		if (e !== null && t.child !== e.child) throw Error(i(153));
		if (t.child !== null) {
			for (e = t.child, n = Ni(e, e.pendingProps), t.child = n, n.return = t; e.sibling !== null;) e = e.sibling, n = n.sibling = Ni(e, e.pendingProps), n.return = t;
			n.sibling = null;
		}
		return t.child;
	}
	function ul(e, t) {
		return (e.lanes & t) !== 0 || (e = e.dependencies, !!(e !== null && Sa(e)));
	}
	function dl(e, t, n) {
		switch (t.tag) {
			case 3:
				Ee(t, t.stateNode.containerInfo), _a(t, ka, e.memoizedState.cache), da();
				break;
			case 27:
			case 5:
				Oe(t);
				break;
			case 4:
				Ee(t, t.stateNode.containerInfo);
				break;
			case 10:
				_a(t, t.type, t.memoizedProps.value);
				break;
			case 31:
				if (t.memoizedState !== null) return t.flags |= 128, Mo(t), null;
				break;
			case 13:
				var r = t.memoizedState;
				if (r !== null) {
					if (r.dehydrated !== null) return jo(t), t.flags |= 128, null;
					r = xa(e, t, n, !1);
					var i = t.child.childLanes;
					return r || (n & i) !== 0 ? Qc(e, t, n) : (jo(t), e = ll(e, t, n), e === null ? null : e.sibling);
				}
				jo(t);
				break;
			case 19:
				if (t.flags & 128) return sl(e, t, n);
				if (i = !!(e.flags & 128), r = (n & t.childLanes) !== 0, r ||= (xa(e, t, n, !1), (n & t.childLanes) !== 0), i) {
					if (r) return sl(e, t, n);
					t.flags |= 128;
				}
				if (i = t.memoizedState, i !== null && (i.rendering = null, i.tail = null, i.lastEffect = null), Lo(t, Io.current), r) break;
				return null;
			case 22: return t.lanes = 0, Rc(e, t, n, t.pendingProps);
			case 24: _a(t, ka, e.memoizedState.cache);
		}
		return ll(e, t, n);
	}
	function fl(e, t, n) {
		if (e !== null) {
			if (e.memoizedProps !== t.pendingProps) Nc = !0;
			else {
				if (!ul(e, n) && !(t.flags & 128)) return Nc = !1, dl(e, t, n);
				Nc = !!(e.flags & 131072);
			}
		} else Nc = !1, V && t.flags & 1048576 && Qi(t, Gi, t.index);
		switch (t.lanes = 0, t.tag) {
			case 16:
				a: {
					var r = t.pendingProps;
					if (e = $a(t.elementType), t.type = e, typeof e == "function") Mi(e) ? (r = Sc(e, r), t.tag = 1, t = qc(null, t, e, r, n)) : (t.tag = 0, t = Gc(null, t, e, r, n));
					else {
						if (e != null) {
							var a = e.$$typeof;
							if (a === re) {
								t.tag = 11, t = Fc(null, t, e, r, n);
								break a;
							}
							if (a === ie) {
								t.tag = 14, t = Ic(null, t, e, r, n);
								break a;
							}
							if (a === M) {
								t.tag = 10, t.type = e, t = cl(null, t, n);
								break a;
							}
						}
						throw t = me(e) || e, Error(i(306, t, ""));
					}
				}
				return t;
			case 0: return Gc(e, t, t.type, t.pendingProps, n);
			case 1: return r = t.type, a = Sc(r, t.pendingProps), qc(e, t, r, a, n);
			case 3:
				a: {
					if (Ee(t, t.stateNode.containerInfo), e === null) throw Error(i(387));
					r = t.pendingProps;
					var o = t.memoizedState;
					a = o.element, mo(e, t), xo(t, r, null, n);
					var s = t.memoizedState;
					if (r = s.cache, _a(t, ka, r), r !== o.cache && ba(t, [ka], n, !0), bo(), r = s.element, o.isDehydrated) {
						if (o = {
							element: r,
							isDehydrated: !1,
							cache: s.cache
						}, t.updateQueue.baseState = o, t.memoizedState = o, t.flags & 256) {
							t = Jc(e, t, r, n);
							break a;
						}
						if (r !== a) {
							a = Vi(Error(i(424)), t), pa(a), t = Jc(e, t, r, n);
							break a;
						}
						switch (e = t.stateNode.containerInfo, e.nodeType) {
							case 9:
								e = e.body;
								break;
							default: e = e.nodeName === "HTML" ? e.ownerDocument.body : e;
						}
						for (ra = mm(e.firstChild), na = t, V = !0, ia = null, aa = !0, n = uo(t, null, r, n), t.child = n; n;) n.flags = n.flags & -3 | 134221824, n = n.sibling;
					} else {
						if (da(), r === a) {
							t = ll(e, t, n);
							break a;
						}
						Pc(e, t, r, n);
					}
					t = t.child;
				}
				return t;
			case 26: return Wc(e, t), e === null ? (n = Lm(t.type, null, t.pendingProps, null)) ? t.memoizedState = n : V || (t.stateNode = _p(t.type, t.pendingProps, we.current, t)) : t.memoizedState = Lm(t.type, e.memoizedProps, t.pendingProps, e.memoizedState), null;
			case 27: return Oe(t), e === null && V && (r = t.stateNode = bm(t.type, t.pendingProps, we.current), na = t, aa = !0, a = ra, Dp(t.type) ? (hm = a, ra = mm(r.firstChild)) : ra = a), Pc(e, t, t.pendingProps.children, n), Wc(e, t), e === null && (t.flags |= 4194304), t.child;
			case 5: return e === null && V && ((a = r = ra) && (r = cm(r, t.type, t.pendingProps, aa), r === null ? a = !1 : (t.stateNode = r, na = t, ra = mm(r.firstChild), aa = !1, a = !0)), a || sa(t)), Oe(t), a = t.type, o = t.pendingProps, s = e === null ? null : e.memoizedProps, r = o.children, vp(a, o) ? r = null : s !== null && vp(a, s) && (t.flags |= 32), t.memoizedState !== null && (a = Qo(e, t, ts, null, null, n), uh._currentValue = a), Wc(e, t), Pc(e, t, r, n), t.child;
			case 6: return e === null && V && ((e = n = ra) && (n = lm(n, t.pendingProps, aa), n === null ? e = !1 : (t.stateNode = n, na = t, ra = null, e = !0)), e || sa(t)), null;
			case 13: return Qc(e, t, n);
			case 4: return Ee(t, t.stateNode.containerInfo), r = t.pendingProps, e === null ? t.child = lo(t, null, r, n) : Pc(e, t, r, n), t.child;
			case 11: return Fc(e, t, t.type, t.pendingProps, n);
			case 7: return r = t.pendingProps, Wc(e, t), Pc(e, t, r, n), t.child;
			case 8: return Pc(e, t, t.pendingProps.children, n), t.child;
			case 12: return Pc(e, t, t.pendingProps.children, n), t.child;
			case 10: return cl(e, t, n);
			case 9: return a = t.type._context, r = t.pendingProps.children, H(t), a = Ca(a), r = r(a), t.flags |= 1, Pc(e, t, r, n), t.child;
			case 14: return Ic(e, t, t.type, t.pendingProps, n);
			case 15: return Lc(e, t, t.type, t.pendingProps, n);
			case 19: return sl(e, t, n);
			case 31: return Uc(e, t, n);
			case 22: return Rc(e, t, n, t.pendingProps);
			case 24: return H(t), r = Ca(ka), e === null ? (a = Wa(), a === null && (a = td, o = Aa(), a.pooledCache = o, o.refCount++, o !== null && (a.pooledCacheLanes |= n), a = o), t.memoizedState = {
				parent: r,
				cache: a
			}, po(t), _a(t, ka, a)) : ((e.lanes & n) !== 0 && (mo(e, t), xo(t, null, null, n), bo()), a = e.memoizedState, o = t.memoizedState, a.parent === r ? (r = o.cache, _a(t, ka, r), r !== a.cache && ba(t, [ka], n, !0)) : (a = {
				parent: r,
				cache: r
			}, t.memoizedState = a, t.lanes === 0 && (t.memoizedState = t.updateQueue.baseState = a), _a(t, ka, r))), Pc(e, t, t.pendingProps.children, n), t.child;
			case 30: return t.stateNode === null && (t.stateNode = {
				autoName: null,
				paired: null,
				clones: null,
				ref: null
			}), r = t.pendingProps, r.name != null && r.name !== "auto" ? t.flags |= e === null ? 18882560 : 18874368 : V && $i(t), e !== null && e.memoizedProps.name !== r.name ? t.flags |= 4194816 : Wc(e, t), Pc(e, t, r.children, n), t.child;
			case 29: throw t.pendingProps;
		}
		throw Error(i(156, t.tag));
	}
	function pl(e) {
		e.flags |= 4;
	}
	function ml(e, t, n, r, i) {
		var a;
		if ((a = !!(e.mode & 32)) && (a = n === null ? Zm(t, r) : Zm(t, r) && (r.src !== n.src || r.srcSet !== n.srcSet)), a) {
			if (e.flags |= 16777216, (i & 335544128) === i) {
				if (e.stateNode.complete) e.flags |= 8192;
				else if (Kd()) e.flags |= 8192;
				else throw eo = Xa, Ja;
			}
		} else e.flags &= -16777217;
	}
	function hl(e, t) {
		if (t.type !== "stylesheet" || t.state.loading & 4) e.flags &= -16777217;
		else if (e.flags |= 16777216, !Qm(t)) {
			if (Kd()) e.flags |= 8192;
			else throw eo = Xa, Ja;
		}
	}
	function gl(e, t) {
		t !== null && (e.flags |= 4), e.flags & 16384 && (t = e.tag === 22 ? 536870912 : ut(), e.lanes |= t, pd |= t);
	}
	function _l(e, t) {
		if (!V) switch (e.tailMode) {
			case "visible": break;
			case "collapsed":
				for (var n = e.tail, r = null; n !== null;) n.alternate !== null && (r = n), n = n.sibling;
				r === null ? t || e.tail === null ? e.tail = null : e.tail.sibling = null : r.sibling = null;
				break;
			default:
				for (t = e.tail, n = null; t !== null;) t.alternate !== null && (n = t), t = t.sibling;
				n === null ? e.tail = null : n.sibling = null;
		}
	}
	function vl(e) {
		var t = e.alternate !== null && e.alternate.child === e.child, n = 0, r = 0;
		if (t) for (var i = e.child; i !== null;) n |= i.lanes | i.childLanes, r |= i.subtreeFlags & 1206910976, r |= i.flags & 1206910976, i.return = e, i = i.sibling;
		else for (i = e.child; i !== null;) n |= i.lanes | i.childLanes, r |= i.subtreeFlags, r |= i.flags, i.return = e, i = i.sibling;
		return e.subtreeFlags |= r, e.childLanes = n, t;
	}
	function yl(e, t, n) {
		var r = t.pendingProps;
		switch (ea(t), t.tag) {
			case 16:
			case 15:
			case 0:
			case 11:
			case 7:
			case 8:
			case 12:
			case 9:
			case 14: return vl(t), null;
			case 1: return vl(t), null;
			case 3: return n = t.stateNode, r = null, e !== null && (r = e.memoizedState.cache), t.memoizedState.cache !== r && (t.flags |= 2048), va(ka), De(), n.pendingContext && (n.context = n.pendingContext, n.pendingContext = null), (e === null || e.child === null) && (ua(t) ? pl(t) : e === null || e.memoizedState.isDehydrated && !(t.flags & 256) || (t.flags |= 1024, fa())), vl(t), null;
			case 26:
				var a = t.type, o = t.memoizedState;
				return e === null ? (pl(t), o === null ? (vl(t), ml(t, a, null, r, n)) : (vl(t), hl(t, o))) : o ? o === e.memoizedState ? (vl(t), t.flags &= -16777217) : (pl(t), vl(t), hl(t, o)) : (e = e.memoizedProps, e !== r && pl(t), vl(t), ml(t, a, e, r, n)), null;
			case 27:
				if (ke(t), n = we.current, a = t.type, e !== null && t.stateNode != null) e.memoizedProps !== r && pl(t);
				else {
					if (!r) {
						if (t.stateNode === null) throw Error(i(166));
						return vl(t), t.subtreeFlags &= -33554433, null;
					}
					e = Se.current, ua(t) ? ca(t, e) : (e = bm(a, r, n), t.stateNode = e, pl(t));
				}
				return vl(t), t.subtreeFlags &= -33554433, null;
			case 5:
				if (ke(t), a = t.type, e !== null && t.stateNode != null) e.memoizedProps !== r && pl(t);
				else {
					if (!r) {
						if (t.stateNode === null) throw Error(i(166));
						return vl(t), t.subtreeFlags &= -33554433, null;
					}
					if (o = Se.current, ua(t)) ca(t, o);
					else {
						var s = mp(we.current);
						switch (o) {
							case 1:
								o = s.createElementNS("http://www.w3.org/2000/svg", a);
								break;
							case 2:
								o = s.createElementNS("http://www.w3.org/1998/Math/MathML", a);
								break;
							default: switch (a) {
								case "svg":
									o = s.createElementNS("http://www.w3.org/2000/svg", a);
									break;
								case "math":
									o = s.createElementNS("http://www.w3.org/1998/Math/MathML", a);
									break;
								case "script":
									o = s.createElement("div"), o.innerHTML = "<script><\/script>", o = o.removeChild(o.firstChild);
									break;
								case "select":
									o = typeof r.is == "string" ? s.createElement("select", { is: r.is }) : s.createElement("select"), r.multiple ? o.multiple = !0 : r.size && (o.size = r.size);
									break;
								default: o = typeof r.is == "string" ? s.createElement(a, { is: r.is }) : s.createElement(a);
							}
						}
						o[St] = t, o[Ct] = r;
						a: for (s = t.child; s !== null;) {
							if (s.tag === 5 || s.tag === 6) o.appendChild(s.stateNode);
							else if (s.tag !== 4 && s.tag !== 27 && s.child !== null) {
								s.child.return = s, s = s.child;
								continue;
							}
							if (s === t) break a;
							for (; s.sibling === null;) {
								if (s.return === null || s.return === t) break a;
								s = s.return;
							}
							s.sibling.return = s.return, s = s.sibling;
						}
						t.stateNode = o;
						a: switch (sp(o, a, r), a) {
							case "button":
							case "input":
							case "select":
							case "textarea":
								r = !!r.autoFocus;
								break a;
							case "img":
								r = !0;
								break a;
							default: r = !1;
						}
						r && pl(t);
					}
				}
				return vl(t), t.subtreeFlags &= -33554433, ml(t, t.type, e === null ? null : e.memoizedProps, t.pendingProps, n), null;
			case 6:
				if (e && t.stateNode != null) e.memoizedProps !== r && pl(t);
				else {
					if (typeof r != "string" && t.stateNode === null) throw Error(i(166));
					if (e = we.current, ua(t)) {
						if (e = t.stateNode, n = t.memoizedProps, r = null, a = na, a !== null) switch (a.tag) {
							case 27:
							case 5: r = a.memoizedProps;
						}
						e[St] = t, e = !!(e.nodeValue === n || r !== null && !0 === r.suppressHydrationWarning || ip(e.nodeValue, n)), e || sa(t, !0);
					} else e = mp(e).createTextNode(r), e[St] = t, t.stateNode = e;
				}
				return vl(t), null;
			case 31:
				if (n = t.memoizedState, e === null || e.memoizedState !== null) {
					if (r = ua(t), n !== null) {
						if (e === null) {
							if (!r) throw Error(i(318));
							if (e = t.memoizedState, e = e === null ? null : e.dehydrated, !e) throw Error(i(557));
							e[St] = t;
						} else da(), !(t.flags & 128) && (t.memoizedState = null), t.flags |= 4;
						vl(t), e = !1;
					} else n = fa(), e !== null && e.memoizedState !== null && (e.memoizedState.hydrationErrors = n), e = !0;
					if (!e) return t.flags & 256 ? (Fo(t), t) : (Fo(t), null);
					if (t.flags & 128) throw Error(i(558));
				}
				return vl(t), null;
			case 13:
				if (r = t.memoizedState, e === null || e.memoizedState !== null && e.memoizedState.dehydrated !== null) {
					if (a = ua(t), r !== null && r.dehydrated !== null) {
						if (e === null) {
							if (!a) throw Error(i(318));
							if (a = t.memoizedState, a = a === null ? null : a.dehydrated, !a) throw Error(i(317));
							a[St] = t;
						} else da(), !(t.flags & 128) && (t.memoizedState = null), t.flags |= 4;
						vl(t), a = !1;
					} else a = fa(), e !== null && e.memoizedState !== null && (e.memoizedState.hydrationErrors = a), a = !0;
					if (!a) return t.flags & 256 ? (Fo(t), t) : (Fo(t), null);
				}
				return Fo(t), t.flags & 128 ? (t.lanes = n, t) : (n = r !== null, e = e !== null && e.memoizedState !== null, n && (r = t.child, a = null, r.alternate !== null && r.alternate.memoizedState !== null && r.alternate.memoizedState.cachePool !== null && (a = r.alternate.memoizedState.cachePool.pool), o = null, r.memoizedState !== null && r.memoizedState.cachePool !== null && (o = r.memoizedState.cachePool.pool), o !== a && (r.flags |= 2048)), n !== e && n && (t.child.flags |= 8192), gl(t, t.updateQueue), vl(t), null);
			case 4: return De(), e === null && Jf(t.stateNode.containerInfo), t.flags |= 67108864, vl(t), null;
			case 10: return va(t.type), vl(t), null;
			case 19:
				if (Ro(t), r = t.memoizedState, r === null) return vl(t), null;
				if (a = !!(t.flags & 128), o = r.rendering, o === null) {
					if (a) _l(r, !1);
					else {
						if (cd !== 0 || e !== null && e.flags & 128) for (e = t.child; e !== null;) {
							if (o = zo(e), o !== null) {
								for (t.flags |= 128, _l(r, !1), e = o.updateQueue, t.updateQueue = e, gl(t, e), t.subtreeFlags = 0, e = n, n = t.child; n !== null;) Pi(n, e), n = n.sibling;
								return Lo(t, Io.current & 1 | 2), V && Zi(t, r.treeForkCount), t.child;
							}
							e = e.sibling;
						}
						r.tail !== null && He() > yd && (t.flags |= 128, a = !0, _l(r, !1), t.lanes = 4194304);
					}
				} else {
					if (!a) {
						if (e = zo(o), e !== null) {
							if (t.flags |= 128, a = !0, e = e.updateQueue, t.updateQueue = e, gl(t, e), _l(r, !0), r.tail === null && r.tailMode !== "collapsed" && r.tailMode !== "visible" && !o.alternate && !V) return vl(t), null;
						} else 2 * He() - r.renderingStartTime > yd && n !== 536870912 && (t.flags |= 128, a = !0, _l(r, !1), t.lanes = 4194304);
					}
					r.isBackwards ? (o.sibling = t.child, t.child = o) : (e = r.last, e === null ? t.child = o : e.sibling = o, r.last = o);
				}
				if (r.tail !== null) {
					e = r.tail;
					a: {
						for (n = e; n !== null;) {
							if (n.alternate !== null) {
								n = !1;
								break a;
							}
							n = n.sibling;
						}
						n = !0;
					}
					return r.rendering = e, r.tail = e.sibling, r.renderingStartTime = He(), e.sibling = null, o = Io.current, o = a ? o & 1 | 2 : o & 1, r.tailMode === "visible" || r.tailMode === "collapsed" || !n || V ? Lo(t, o) : (n = o, xe(ko, t), xe(Io, n), Ao === null && (Ao = t)), V && Zi(t, r.treeForkCount), e;
				}
				return vl(t), null;
			case 22:
			case 23: return Fo(t), Oo(), r = t.memoizedState !== null, e === null ? r && (t.flags |= 8192) : e.memoizedState !== null !== r && (t.flags |= 8192), r ? n & 536870912 && !(t.flags & 128) && (vl(t), t.subtreeFlags & 6 && (t.flags |= 8192)) : vl(t), n = t.updateQueue, n !== null && gl(t, n.retryQueue), n = null, e !== null && e.memoizedState !== null && e.memoizedState.cachePool !== null && (n = e.memoizedState.cachePool.pool), r = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (r = t.memoizedState.cachePool.pool), r !== n && (t.flags |= 2048), e !== null && be(Ua), null;
			case 24: return n = null, e !== null && (n = e.memoizedState.cache), t.memoizedState.cache !== n && (t.flags |= 2048), va(ka), vl(t), null;
			case 25: return null;
			case 30: return t.flags |= 33554432, vl(t), null;
		}
		throw Error(i(156, t.tag));
	}
	function bl(e, t) {
		switch (ea(t), t.tag) {
			case 1: return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
			case 3: return va(ka), De(), e = t.flags, e & 65536 && !(e & 128) ? (t.flags = e & -65537 | 128, t) : null;
			case 26:
			case 27:
			case 5: return ke(t), null;
			case 31:
				if (t.memoizedState !== null) {
					if (Fo(t), t.alternate === null) throw Error(i(340));
					da();
				}
				return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
			case 13:
				if (Fo(t), e = t.memoizedState, e !== null && e.dehydrated !== null) {
					if (t.alternate === null) throw Error(i(340));
					da();
				}
				return e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
			case 19: return Ro(t), e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, e = t.memoizedState, e !== null && (e.rendering = null, e.tail = null), t.flags |= 4, t) : null;
			case 4: return De(), null;
			case 10: return va(t.type), null;
			case 22:
			case 23: return Fo(t), Oo(), e !== null && be(Ua), e = t.flags, e & 65536 ? (t.flags = e & -65537 | 128, t) : null;
			case 24: return va(ka), null;
			case 25: return null;
			default: return null;
		}
	}
	function xl(e, t) {
		switch (ea(t), t.tag) {
			case 3:
				va(ka), De();
				break;
			case 26:
			case 27:
			case 5:
				ke(t);
				break;
			case 4:
				De();
				break;
			case 31:
				t.memoizedState !== null && Fo(t);
				break;
			case 13:
				Fo(t);
				break;
			case 19:
				Ro(t);
				break;
			case 10:
				va(t.type);
				break;
			case 22:
			case 23:
				Fo(t), Oo(), e !== null && be(Ua);
				break;
			case 24: va(ka);
		}
	}
	function Sl(e, t) {
		try {
			var n = t.updateQueue, r = n === null ? null : n.lastEffect;
			if (r !== null) {
				var i = r.next;
				n = i;
				do {
					if ((n.tag & e) === e) {
						r = void 0;
						var a = n.create, o = n.inst;
						r = a(), o.destroy = r;
					}
					n = n.next;
				} while (n !== i);
			}
		} catch (e) {
			_f(t, t.return, e);
		}
	}
	function Cl(e, t, n) {
		try {
			var r = t.updateQueue, i = r === null ? null : r.lastEffect;
			if (i !== null) {
				var a = i.next;
				r = a;
				do {
					if ((r.tag & e) === e) {
						var o = r.inst, s = o.destroy;
						if (s !== void 0) {
							o.destroy = void 0, i = t;
							var c = n, l = s;
							try {
								l();
							} catch (e) {
								_f(i, c, e);
							}
						}
					}
					r = r.next;
				} while (r !== a);
			}
		} catch (e) {
			_f(t, t.return, e);
		}
	}
	function wl(e) {
		var t = e.updateQueue;
		if (t !== null) {
			var n = e.stateNode;
			try {
				Co(t, n);
			} catch (t) {
				_f(e, e.return, t);
			}
		}
	}
	function Tl(e, t, n) {
		n.props = Sc(e.type, e.memoizedProps), n.state = e.memoizedState;
		try {
			n.componentWillUnmount();
		} catch (n) {
			_f(e, t, n);
		}
	}
	function El(e, t) {
		try {
			var n = e.ref;
			if (n !== null) {
				switch (e.tag) {
					case 26:
					case 27:
					case 5:
						var r = e.stateNode;
						break;
					case 30:
						var i = e.stateNode, a = gi(e.memoizedProps, i);
						(i.ref === null || i.ref.name !== a) && (i.ref = zp(a)), r = i.ref;
						break;
					case 7:
						if (e.stateNode === null) {
							var o = new Bp(e);
							m(e.child, !1, rm, o, void 0, void 0), e.stateNode = o;
						}
						r = e.stateNode;
						break;
					default: r = e.stateNode;
				}
				typeof n == "function" ? e.refCleanup = n(r) : n.current = r;
			}
		} catch (n) {
			_f(e, t, n);
		}
	}
	function Dl(e, t) {
		var n = e.ref, r = e.refCleanup;
		if (n !== null) {
			if (typeof r == "function") try {
				r();
			} catch (n) {
				_f(e, t, n);
			} finally {
				e.refCleanup = null, e = e.alternate, e != null && (e.refCleanup = null);
			}
			else if (typeof n == "function") try {
				n(null);
			} catch (n) {
				_f(e, t, n);
			}
			else n.current = null;
		}
	}
	function Ol(e, t) {
		if ((e.tag === 5 || e.tag === 27 || e.tag === 6) && e.alternate === null && t !== null) for (var n = 0; n < t.length; n++) am(e.stateNode, t[n]);
	}
	function kl(e) {
		for (var t = e.return; t !== null && (Ml(t) && am(e.stateNode, t.stateNode), !jl(t));) t = t.return;
	}
	function Al(e) {
		for (var t = e.return; t !== null && (Ml(t) && om(e.stateNode, t.stateNode), !jl(t));) t = t.return;
	}
	function jl(e) {
		return e.tag === 5 || e.tag === 3 || e.tag === 27;
	}
	function Ml(e) {
		return e && e.tag === 7 && e.stateNode !== null;
	}
	function Nl(e) {
		var t = e.type, n = e.memoizedProps, r = e.stateNode;
		try {
			a: switch (t) {
				case "button":
				case "input":
				case "select":
				case "textarea":
					n.autoFocus && r.focus();
					break a;
				case "img": n.src ? r.src = n.src : n.srcSet && (r.srcset = n.srcSet);
			}
		} catch (t) {
			_f(e, e.return, t);
		}
	}
	function Pl(e, t, n) {
		try {
			var r = e.stateNode;
			lp(r, e.type, n, t), r[Ct] = t;
		} catch (t) {
			_f(e, e.return, t);
		}
	}
	function Fl(e) {
		return e.tag === 5 || e.tag === 3 || e.tag === 26 || e.tag === 27 && Dp(e.type) || e.tag === 4;
	}
	function Il(e) {
		a: for (;;) {
			for (; e.sibling === null;) {
				if (e.return === null || Fl(e.return)) return null;
				e = e.return;
			}
			for (e.sibling.return = e.return, e = e.sibling; e.tag !== 5 && e.tag !== 6 && e.tag !== 18;) {
				if (e.tag === 27 && Dp(e.type) || e.flags & 2 || e.child === null || e.tag === 4) continue a;
				e.child.return = e, e = e.child;
			}
			if (!(e.flags & 2)) return e.stateNode;
		}
	}
	function Ll(e, t, n, r) {
		var i = e.tag;
		if (i === 5 || i === 6) i = e.stateNode, t ? (n.nodeType === 9 ? n.body : n.nodeName === "HTML" ? n.ownerDocument.body : n).insertBefore(i, t) : (t = n.nodeType === 9 ? n.body : n.nodeName === "HTML" ? n.ownerDocument.body : n, t.appendChild(i), n = n._reactRootContainer, n != null || t.onclick !== null || (t.onclick = vn)), Ol(e, r), z = !0;
		else if (i !== 4 && (i === 27 && (Ol(e, r), r = null, Dp(e.type) && (n = e.stateNode, t = null)), e = e.child, e !== null)) for (Ll(e, t, n, r), e = e.sibling; e !== null;) Ll(e, t, n, r), e = e.sibling;
	}
	function Rl(e, t, n, r) {
		var i = e.tag;
		if (i === 5 || i === 6) i = e.stateNode, t ? n.insertBefore(i, t) : n.appendChild(i), Ol(e, r), z = !0;
		else if (i !== 4 && (i === 27 && (Ol(e, r), r = null, Dp(e.type) && (n = e.stateNode)), e = e.child, e !== null)) for (Rl(e, t, n, r), e = e.sibling; e !== null;) Rl(e, t, n, r), e = e.sibling;
	}
	function zl(e) {
		var t = e.stateNode, n = e.memoizedProps;
		try {
			for (var r = e.type, i = t.attributes; i.length;) t.removeAttributeNode(i[0]);
			sp(t, r, n), t[St] = e, t[Ct] = n;
		} catch (t) {
			_f(e, e.return, t);
		}
	}
	var Bl = !1, Vl = null;
	function Hl(e) {
		(e.tag === 30 || e.subtreeFlags & 33554432) && (Bl = !0);
	}
	var Ul = null;
	function Wl() {
		var e = Ul;
		return Ul = null, e;
	}
	var Gl = 0;
	function Kl(e, t, n, r, i) {
		return Gl = 0, ql(e.child, t, n, r, i);
	}
	function ql(e, t, n, r, i) {
		for (var a = !1; e !== null;) {
			if (e.tag === 5) {
				var o = e.stateNode;
				if (r !== null) {
					var s = Np(o);
					r.push(s), s.view && (a = !0);
				} else a || Np(o).view && (a = !0);
				Bl = !0, Ap(o, Gl === 0 ? t : t + "_" + Gl, n), Gl++;
			} else (e.tag !== 22 || e.memoizedState === null) && (e.tag === 30 && i || ql(e.child, t, n, r, i) && (a = !0));
			e = e.sibling;
		}
		return a;
	}
	function Jl(e, t) {
		for (; e !== null;) e.tag === 5 ? jp(e.stateNode, e.memoizedProps) : (e.tag !== 22 || e.memoizedState === null) && (e.tag === 30 && t || Jl(e.child, t)), e = e.sibling;
	}
	function Yl(e) {
		if (e.subtreeFlags & 18874368) for (e = e.child; e !== null;) {
			if ((e.tag !== 22 || e.memoizedState === null) && (Yl(e), e.tag === 30 && e.flags & 18874368 && e.stateNode.paired)) {
				var t = e.memoizedProps;
				if (t.name == null || t.name === "auto") throw Error(i(544));
				var n = t.name;
				t = vi(t.default, t.share), t !== "none" && (Kl(e, n, t, null, !1) || Jl(e.child, !1));
			}
			e = e.sibling;
		}
	}
	function Xl(e, t) {
		if (e.tag === 30) {
			var n = e.stateNode, r = e.memoizedProps, i = gi(r, n), a = vi(r.default, n.paired ? r.share : r.enter);
			a === "none" ? Yl(e) : Kl(e, i, a, null, !1) ? (Yl(e), n.paired || t || Id(e, r.onEnter)) : Jl(e.child, !1);
		} else if (e.subtreeFlags & 33554432) for (e = e.child; e !== null;) Xl(e, t), e = e.sibling;
		else Yl(e);
	}
	function Zl(e) {
		if (Vl !== null && Vl.size !== 0) {
			var t = Vl;
			if (e.subtreeFlags & 18874368) for (e = e.child; e !== null;) {
				if (e.tag !== 22 || e.memoizedState === null) {
					if (e.tag === 30 && e.flags & 18874368) {
						var n = e.memoizedProps, r = n.name;
						if (r != null && r !== "auto") {
							var i = t.get(r);
							if (i !== void 0) {
								var a = vi(n.default, n.share);
								if (a !== "none" && (Kl(e, r, a, null, !1) ? (a = e.stateNode, i.paired = a, a.paired = i, Id(e, n.onShare)) : Jl(e.child, !1)), t.delete(r), t.size === 0) break;
							}
						}
					}
					Zl(e);
				}
				e = e.sibling;
			}
		}
	}
	function Ql(e) {
		if (e.tag === 30) {
			var t = e.memoizedProps, n = gi(t, e.stateNode), r = Vl === null ? void 0 : Vl.get(n), i = vi(t.default, r === void 0 ? t.exit : t.share);
			i !== "none" && (Kl(e, n, i, null, !1) ? r === void 0 ? Id(e, t.onExit) : (i = e.stateNode, r.paired = i, i.paired = r, Vl.delete(n), Id(e, t.onShare)) : Jl(e.child, !1)), Vl !== null && Zl(e);
		} else if (e.subtreeFlags & 33554432) for (e = e.child; e !== null;) Ql(e), e = e.sibling;
		else Vl !== null && Zl(e);
	}
	function $l(e) {
		for (e = e.child; e !== null;) {
			if (e.tag === 30) {
				var t = e.memoizedProps, n = gi(t, e.stateNode);
				t = vi(t.default, t.update), e.flags &= -5, t !== "none" && Kl(e, n, t, e.memoizedState = [], !1);
			} else e.subtreeFlags & 33554432 && $l(e);
			e = e.sibling;
		}
	}
	function eu(e) {
		if (e.subtreeFlags & 18874368) for (e = e.child; e !== null;) {
			if (e.tag !== 22 || e.memoizedState === null) {
				if (e.tag === 30 && e.flags & 18874368) {
					var t = e.stateNode;
					t.paired !== null && (t.paired = null, Jl(e.child, !1));
				}
				eu(e);
			}
			e = e.sibling;
		}
	}
	function tu(e) {
		if (e.tag === 30) e.stateNode.paired = null, Jl(e.child, !1), eu(e);
		else if (e.subtreeFlags & 33554432) for (e = e.child; e !== null;) tu(e), e = e.sibling;
		else eu(e);
	}
	function nu(e) {
		for (e = e.child; e !== null;) e.tag === 30 ? Jl(e.child, !1) : e.subtreeFlags & 33554432 && nu(e), e = e.sibling;
	}
	function ru(e, t, n, r, i, a, o) {
		for (var s = !1; t !== null;) {
			if (t.tag === 5) {
				var c = t.stateNode;
				if (a !== null && Gl < a.length) {
					var l = a[Gl], u = Np(c);
					(l.view || u.view) && (s = !0);
					var d;
					if (d = !(e.flags & 4)) {
						if (u.clip) d = !0;
						else {
							d = l.rect;
							var f = u.rect;
							d = d.y !== f.y || d.x !== f.x || d.height !== f.height || d.width !== f.width;
						}
					}
					d && (e.flags |= 4), u.abs ? u = !l.abs : (l = l.rect, u = u.rect, u = l.height !== u.height || l.width !== u.width), u && (e.flags |= 32);
				} else e.flags |= 32;
				e.flags & 4 && Ap(c, Gl === 0 ? n : n + "_" + Gl, i), s && e.flags & 4 || (Ul === null && (Ul = []), Ul.push(c, Gl === 0 ? r : r + "_" + Gl, t.memoizedProps)), Gl++;
			} else (t.tag !== 22 || t.memoizedState === null) && (t.tag === 30 && o ? e.flags |= t.flags & 32 : ru(e, t.child, n, r, i, a, o) && (s = !0));
			t = t.sibling;
		}
		return s;
	}
	function iu(e, t) {
		for (e = e.child; e !== null;) {
			if (e.tag === 30) {
				var n = e.memoizedProps, r = e.stateNode, i = gi(n, r), a = vi(n.default, n.update);
				if (t) {
					r = r.clones;
					var o = r === null ? null : r.map(Pp);
				} else o = e.memoizedState, e.memoizedState = null;
				r = e;
				var s = e.child;
				Gl = 0, i = ru(r, s, i, i, a, o, !1), e.flags & 4 && i && (t || Id(e, n.onUpdate));
			} else e.subtreeFlags & 33554432 && iu(e, t);
			e = e.sibling;
		}
	}
	var au = !1, W = !1, ou = !1, su = !1, cu = typeof WeakSet == "function" ? WeakSet : Set, lu = null, uu = !1, du = !1, fu = !1, pu = !1;
	function mu(e, t, n) {
		if (e = e.containerInfo, fp = yh, e = qr(e), Jr(e)) {
			if ("selectionStart" in e) var r = {
				start: e.selectionStart,
				end: e.selectionEnd
			};
			else a: {
				r = (r = e.ownerDocument) && r.defaultView || window;
				var i = r.getSelection && r.getSelection();
				if (i && i.rangeCount !== 0) {
					r = i.anchorNode;
					var a = i.anchorOffset, o = i.focusNode;
					i = i.focusOffset;
					try {
						r.nodeType, o.nodeType;
					} catch {
						r = null;
						break a;
					}
					var s = 0, c = -1, l = -1, u = 0, d = 0, f = e, p = null;
					b: for (;;) {
						for (var m; f !== r || a !== 0 && f.nodeType !== 3 || (c = s + a), f !== o || i !== 0 && f.nodeType !== 3 || (l = s + i), f.nodeType === 3 && (s += f.nodeValue.length), (m = f.firstChild) !== null;) p = f, f = m;
						for (;;) {
							if (f === e) break b;
							if (p === r && ++u === a && (c = s), p === o && ++d === i && (l = s), (m = f.nextSibling) !== null) break;
							f = p, p = f.parentNode;
						}
						f = m;
					}
					r = c === -1 || l === -1 ? null : {
						start: c,
						end: l
					};
				} else r = null;
			}
			r ||= {
				start: 0,
				end: 0
			};
		} else r = null;
		for (pp = {
			focusedElem: e,
			selectionRange: r
		}, yh = !1, n = (n & 335544064) === n, lu = t, t = n ? 9270 : 1024; lu !== null;) {
			if (e = lu, n && (r = e.deletions, r !== null)) for (a = 0; a < r.length; a++) n && Ql(r[a]);
			if (e.alternate === null && e.flags & 2) n && Hl(e), hu(n);
			else {
				if (e.tag === 22) {
					if (r = e.alternate, e.memoizedState !== null) {
						r !== null && r.memoizedState === null && n && Ql(r), hu(n);
						continue;
					}
					if (r !== null && r.memoizedState !== null) {
						n && Hl(e), hu(n);
						continue;
					}
				}
				r = e.child, (e.subtreeFlags & t) !== 0 && r !== null ? (r.return = e, lu = r) : (n && $l(e), hu(n));
			}
		}
		Vl = null;
	}
	function hu(e) {
		for (; lu !== null;) {
			var t = lu, n = e, r = t.alternate, a = t.flags;
			switch (t.tag) {
				case 0:
				case 11:
				case 15: break;
				case 1:
					if (a & 1024 && r !== null) {
						n = void 0, a = r.memoizedProps, r = r.memoizedState;
						var o = t.stateNode;
						try {
							var s = Sc(t.type, a);
							n = o.getSnapshotBeforeUpdate(s, r), o.__reactInternalSnapshotBeforeUpdate = n;
						} catch (e) {
							_f(t, t.return, e);
						}
					}
					break;
				case 3:
					if (a & 1024) {
						if (r = t.stateNode.containerInfo, n = r.nodeType, n === 9) sm(r);
						else if (n === 1) switch (r.nodeName) {
							case "HEAD":
							case "HTML":
							case "BODY":
								sm(r);
								break;
							default: r.textContent = "";
						}
					}
					break;
				case 5:
				case 26:
				case 27:
				case 6:
				case 4:
				case 17: break;
				case 30:
					n && r !== null && (n = gi(r.memoizedProps, r.stateNode), a = t.memoizedProps, a = vi(a.default, a.update), a !== "none" && Kl(r, n, a, r.memoizedState = [], !0));
					break;
				default: if (a & 1024) throw Error(i(163));
			}
			if (r = t.sibling, r !== null) {
				r.return = t.return, lu = r;
				break;
			}
			lu = t.return;
		}
	}
	function gu(e, t, n) {
		var r = n.flags;
		switch (n.tag) {
			case 0:
			case 11:
			case 15:
				Iu(e, n), r & 4 && Sl(5, n);
				break;
			case 1:
				if (Iu(e, n), r & 4) {
					if (e = n.stateNode, t === null) try {
						e.componentDidMount();
					} catch (e) {
						_f(n, n.return, e);
					}
					else {
						var i = Sc(n.type, t.memoizedProps);
						t = t.memoizedState;
						try {
							e.componentDidUpdate(i, t, e.__reactInternalSnapshotBeforeUpdate);
						} catch (e) {
							_f(n, n.return, e);
						}
					}
				}
				r & 64 && wl(n), r & 512 && El(n, n.return);
				break;
			case 3:
				if (Iu(e, n), r & 64 && (e = n.updateQueue, e !== null)) {
					if (t = null, n.child !== null) switch (n.child.tag) {
						case 27:
						case 5:
							t = n.child.stateNode;
							break;
						case 1: t = n.child.stateNode;
					}
					try {
						Co(e, t);
					} catch (e) {
						_f(n, n.return, e);
					}
				}
				break;
			case 27: t === null && r & 4 && zl(n);
			case 26:
			case 5:
				Iu(e, n), t === null && r & 4 && Nl(n), r & 512 && El(n, n.return);
				break;
			case 12:
				Iu(e, n);
				break;
			case 31:
				Iu(e, n), r & 4 && Tu(e, n);
				break;
			case 13:
				Iu(e, n), r & 4 && Eu(e, n), r & 64 && (e = n.memoizedState, e !== null && (e = e.dehydrated, e !== null && (n = xf.bind(null, n), pm(e, n))));
				break;
			case 22:
				if (r = n.memoizedState !== null || au, !r) {
					var a = t !== null && t.memoizedState !== null || W;
					t = au, i = W, au = r, (W = a) && !i ? (r = 2, n.subtreeFlags & 8772 && (r |= 1), Ru(e, n, r)) : Iu(e, n), au = t, W = i;
				}
				break;
			case 30:
				Iu(e, n), r & 512 && El(n, n.return);
				break;
			case 7: r & 512 && El(n, n.return);
			default: Iu(e, n);
		}
	}
	function _u(e, t) {
		for (e = e.child; e !== null;) vu(e, t), e = e.sibling;
	}
	function vu(e, t) {
		switch (e.tag) {
			case 5:
			case 26:
				try {
					var n = e.stateNode;
					if (t) {
						var r = n.style;
						typeof r.setProperty == "function" ? r.setProperty("display", "none", "important") : r.display = "none";
					} else {
						var i = e.stateNode, a = e.memoizedProps.style, o = a != null && a.hasOwnProperty("display") ? a.display : null;
						i.style.display = o == null || typeof o == "boolean" ? "" : ("" + o).trim();
					}
				} catch (t) {
					_f(e, e.return, t);
				}
				yu(e, t);
				break;
			case 6:
				try {
					e.stateNode.nodeValue = t ? "" : e.memoizedProps, z = !0;
				} catch (t) {
					_f(e, e.return, t);
				}
				break;
			case 18:
				try {
					var s = e.stateNode;
					t ? kp(s, !0) : kp(e.stateNode, !1);
				} catch (t) {
					_f(e, e.return, t);
				}
				break;
			case 22:
			case 23:
				e.memoizedState === null && _u(e, t);
				break;
			default: _u(e, t);
		}
	}
	function yu(e, t) {
		if (e.subtreeFlags & 67108864) for (e = e.child; e !== null;) {
			a: {
				var n = e, r = t;
				switch (n.tag) {
					case 4:
						vu(n, r);
						break a;
					case 22:
						n.memoizedState === null && yu(n, r);
						break a;
					default: yu(n, r);
				}
			}
			e = e.sibling;
		}
	}
	function bu(e) {
		var t = e.alternate;
		t !== null && (e.alternate = null, bu(t)), e.child = null, e.deletions = null, e.sibling = null, e.tag === 5 && (t = e.stateNode, t !== null && jt(t)), e.stateNode = null, e.return = null, e.dependencies = null, e.memoizedProps = null, e.memoizedState = null, e.pendingProps = null, e.stateNode = null, e.updateQueue = null;
	}
	var xu = null, Su = !1;
	function Cu(e, t, n) {
		for (n = n.child; n !== null;) wu(e, t, n), n = n.sibling;
	}
	function wu(e, t, n) {
		if (L && typeof L.onCommitFiberUnmount == "function") try {
			L.onCommitFiberUnmount(Ze, n);
		} catch {}
		switch (n.tag) {
			case 26:
				W || Dl(n, t), Cu(e, t, n), n.memoizedState ? n.memoizedState.count-- : n.stateNode && !W && (n = n.stateNode, n.parentNode.removeChild(n));
				break;
			case 27:
				W || Dl(n, t), Al(n);
				var r = xu, i = Su;
				Dp(n.type) && (xu = n.stateNode, Su = !1), Cu(e, t, n), xm(n.stateNode, n.type, n.memoizedProps), xu = r, Su = i;
				break;
			case 5: W || Dl(n, t), Al(n);
			case 6:
				if (n.tag === 6 && Al(n), r = xu, i = Su, xu = null, Cu(e, t, n), xu = r, Su = i, xu !== null) {
					if (Su) try {
						(xu.nodeType === 9 ? xu.body : xu.nodeName === "HTML" ? xu.ownerDocument.body : xu).removeChild(n.stateNode), z = !0;
					} catch (e) {
						_f(n, t, e);
					}
					else try {
						xu.removeChild(n.stateNode), z = !0;
					} catch (e) {
						_f(n, t, e);
					}
				}
				break;
			case 18:
				xu !== null && (Su ? (e = xu, Op(e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e, n.stateNode), Gh(e)) : Op(xu, n.stateNode));
				break;
			case 4:
				r = xu, i = Su, xu = n.stateNode.containerInfo, Su = !0, Cu(e, t, n), xu = r, Su = i;
				break;
			case 0:
			case 11:
			case 14:
			case 15:
				Cl(2, n, t), W || Cl(4, n, t), Cu(e, t, n);
				break;
			case 1:
				W || (Dl(n, t), r = n.stateNode, typeof r.componentWillUnmount == "function" && Tl(n, t, r)), Cu(e, t, n);
				break;
			case 21:
				Cu(e, t, n);
				break;
			case 22:
				W = (r = W) || n.memoizedState !== null, Cu(e, t, n), W = r;
				break;
			case 30:
				Dl(n, t), Cu(e, t, n);
				break;
			case 7:
				W || Dl(n, t), Cu(e, t, n);
				break;
			default: Cu(e, t, n);
		}
	}
	function Tu(e, t) {
		if (t.memoizedState === null && (e = t.alternate, e !== null && (e = e.memoizedState, e !== null))) {
			e = e.dehydrated;
			try {
				Gh(e);
			} catch (e) {
				_f(t, t.return, e);
			}
		}
	}
	function Eu(e, t) {
		if (t.memoizedState === null && (e = t.alternate, e !== null && (e = e.memoizedState, e !== null && (e = e.dehydrated, e !== null)))) try {
			Gh(e);
		} catch (e) {
			_f(t, t.return, e);
		}
	}
	function Du(e) {
		switch (e.tag) {
			case 31:
			case 13:
			case 19:
				var t = e.stateNode;
				return t === null && (t = e.stateNode = new cu()), t;
			case 22: return e = e.stateNode, t = e._retryCache, t === null && (t = e._retryCache = new cu()), t;
			default: throw Error(i(435, e.tag));
		}
	}
	function Ou(e, t) {
		var n = Du(e);
		t.forEach(function(t) {
			if (!n.has(t)) {
				n.add(t);
				var r = Sf.bind(null, e, t);
				t.then(r, r);
			}
		});
	}
	function ku(e, t, n) {
		var r = t.deletions;
		if (r !== null) for (var a = 0; a < r.length; a++) {
			var o = r[a], s = e, c = t, l = c;
			a: for (; l !== null;) {
				switch (l.tag) {
					case 27:
						if (Dp(l.type)) {
							xu = l.stateNode, Su = !1;
							break a;
						}
						break;
					case 5:
						xu = l.stateNode, Su = !1;
						break a;
					case 3:
					case 4:
						xu = l.stateNode.containerInfo, Su = !0;
						break a;
				}
				l = l.return;
			}
			if (xu === null) throw Error(i(160));
			wu(s, c, o), xu = null, Su = !1, s = o.alternate, s !== null && (s.return = null), o.return = null;
		}
		if (t.subtreeFlags & 13886) for (t = t.child; t !== null;) ju(t, e, n), t = t.sibling;
	}
	var Au = null;
	function ju(e, t, n) {
		var r = e.alternate, a = e.flags;
		switch (e.tag) {
			case 0:
			case 11:
			case 14:
			case 15:
				if (a & 4 && (r = e.updateQueue, r = r === null ? null : r.events, r !== null)) for (var o = 0; o < r.length; o++) {
					var s = r[o];
					s.ref.impl = s.nextImpl;
				}
				ku(t, e, n), Mu(e), a & 4 && (Cl(3, e, e.return), Sl(3, e), Cl(5, e, e.return));
				break;
			case 1:
				ku(t, e, n), Mu(e), a & 512 && (W || r === null || Dl(r, r.return)), a & 64 && au && (e = e.updateQueue, e !== null && (t = e.callbacks, t !== null && (n = e.shared.hiddenCallbacks, e.shared.hiddenCallbacks = n === null ? t : n.concat(t))));
				break;
			case 26:
				if (o = Au, ku(t, e, n), Mu(e), a & 512 && (W || r === null || Dl(r, r.return)), a & 4) {
					if (a = r === null ? null : r.memoizedState, n = e.memoizedState, r === null) {
						if (n === null) {
							if (e.stateNode === null) {
								if (au) e.stateNode = _p(e.type, e.memoizedProps, t.containerInfo, e);
								else {
									a: {
										t = e.type, n = e.memoizedProps, a = o.ownerDocument || o;
										b: switch (t) {
											case "title":
												r = a.getElementsByTagName("title")[0], (!r || r[kt] || r[St] || r.namespaceURI === "http://www.w3.org/2000/svg" || r.hasAttribute("itemprop")) && (r = a.createElement(t), a.head.insertBefore(r, a.querySelector("head > title"))), sp(r, t, n), r[St] = e, It(r), t = r;
												break a;
											case "link":
												if (o = Jm("link", "href", a).get(t + (n.href || ""))) {
													for (s = 0; s < o.length; s++) if (r = o[s], r.getAttribute("href") === (n.href == null || n.href === "" ? null : n.href) && r.getAttribute("rel") === (n.rel == null ? null : n.rel) && r.getAttribute("title") === (n.title == null ? null : n.title) && r.getAttribute("crossorigin") === (n.crossOrigin == null ? null : n.crossOrigin)) {
														o.splice(s, 1);
														break b;
													}
												}
												r = a.createElement(t), sp(r, t, n), a.head.appendChild(r);
												break;
											case "meta":
												if (o = Jm("meta", "content", a).get(t + (n.content || ""))) {
													for (s = 0; s < o.length; s++) if (r = o[s], r.getAttribute("content") === (n.content == null ? null : "" + n.content) && r.getAttribute("name") === (n.name == null ? null : n.name) && r.getAttribute("property") === (n.property == null ? null : n.property) && r.getAttribute("http-equiv") === (n.httpEquiv == null ? null : n.httpEquiv) && r.getAttribute("charset") === (n.charSet == null ? null : n.charSet)) {
														o.splice(s, 1);
														break b;
													}
												}
												r = a.createElement(t), sp(r, t, n), a.head.appendChild(r);
												break;
											default: throw Error(i(468, t));
										}
										r[St] = e, It(r), t = r;
									}
									e.stateNode = t;
								}
							} else au || Ym(o, e.type, e.stateNode);
						} else e.stateNode = Um(o, n, e.memoizedProps);
					} else a === n ? n === null && e.stateNode !== null && Pl(e, e.memoizedProps, r.memoizedProps) : (a === null ? (t = r.stateNode, t === null || W || t.parentNode.removeChild(t)) : a.count--, n === null ? au || Ym(o, e.type, e.stateNode) : Um(o, n, e.memoizedProps));
				}
				break;
			case 27:
				ku(t, e, n), Mu(e), a & 512 && (W || r === null || Dl(r, r.return)), r !== null && a & 4 && Pl(e, e.memoizedProps, r.memoizedProps);
				break;
			case 5:
				if (o = ou, ou = !1, ku(t, e, n), ou = o, Mu(e), a & 512 && (W || r === null || Dl(r, r.return)), e.flags & 32) {
					t = e.stateNode;
					try {
						un(t, ""), z = !0;
					} catch (t) {
						_f(e, e.return, t);
					}
				}
				a & 4 && e.stateNode != null && (t = e.memoizedProps, Pl(e, t, r === null ? t : r.memoizedProps)), a & 1024 && (su = !0);
				break;
			case 6:
				if (ku(t, e, n), Mu(e), a & 4) {
					if (e.stateNode === null) throw Error(i(162));
					t = e.memoizedProps, n = e.stateNode;
					try {
						n.nodeValue = t, z = !0;
					} catch (t) {
						_f(e, e.return, t);
					}
				}
				break;
			case 3:
				if (z = !1, qm = null, o = Au, Au = Tm(t.containerInfo), ku(t, e, n), Au = o, Mu(e), a & 4 && r !== null && r.memoizedState.isDehydrated) try {
					Gh(t.containerInfo);
				} catch (t) {
					_f(e, e.return, t);
				}
				su && (su = !1, Nu(e)), z = !1;
				break;
			case 4:
				a = ou, ou = au, r = Kt(), o = Au, Au = Tm(e.stateNode.containerInfo), ku(t, e, n), Mu(e), Au = o, z && du && (fu = !0), z = r, ou = a;
				break;
			case 12:
				ku(t, e, n), Mu(e);
				break;
			case 31:
				ku(t, e, n), Mu(e), a & 4 && (t = e.updateQueue, t !== null && (e.updateQueue = null, Ou(e, t)));
				break;
			case 13:
				ku(t, e, n), Mu(e), e.child.flags & 8192 && e.memoizedState !== null != (r !== null && r.memoizedState !== null) && (_d = He()), a & 4 && (t = e.updateQueue, t !== null && (e.updateQueue = null, Ou(e, t)));
				break;
			case 22:
				o = e.memoizedState !== null, s = r !== null && r.memoizedState !== null;
				var c = au, l = W, u = ou;
				au = c || o, ou = u || o, W = l || s, ku(t, e, n), W = l, ou = u, au = c, Mu(e), a & 8192 && (t = e.stateNode, t._visibility = o ? t._visibility & -2 : t._visibility | 1, !o || r === null || s || au || W || (t = s || W, n = au, r = W, au = o || au, W = t, Lu(e, 2), au = n, W = r), !o && ou || _u(e, o)), a & 4 && (t = e.updateQueue, t !== null && (n = t.retryQueue, n !== null && (t.retryQueue = null, Ou(e, n))));
				break;
			case 19:
				ku(t, e, n), Mu(e), a & 4 && (t = e.updateQueue, t !== null && (e.updateQueue = null, Ou(e, t)));
				break;
			case 30:
				a & 512 && (W || r === null || Dl(r, r.return)), a = Kt(), o = du, s = (n & 335544064) === n, c = e.memoizedProps, du = s && vi(c.default, c.update) !== "none", ku(t, e, n), Mu(e), s && r !== null && z && (e.flags |= 4), du = o, z = a;
				break;
			case 21: break;
			case 7: a & 512 && (W || r === null || Dl(r, r.return)), r && r.stateNode !== null && (r.stateNode._fragmentFiber = e);
			default: ku(t, e, n), Mu(e);
		}
	}
	function Mu(e) {
		var t = e.flags;
		if (t & 2) {
			try {
				for (var n, r = e.return; r !== null;) {
					if (Fl(r)) {
						n = r;
						break;
					}
					r = r.return;
				}
				r = null;
				for (var a = e.return; a !== null;) {
					if (Ml(a)) {
						var o = a.stateNode;
						r === null ? r = [o] : r.push(o);
					}
					if (jl(a)) break;
					a = a.return;
				}
				var s = r;
				if (n == null) throw Error(i(160));
				switch (n.tag) {
					case 27:
						var c = n.stateNode;
						Rl(e, Il(e), c, s);
						break;
					case 5:
						var l = n.stateNode;
						n.flags & 32 && (un(l, ""), n.flags &= -33), Rl(e, Il(e), l, s);
						break;
					case 3:
					case 4:
						var u = n.stateNode.containerInfo;
						Ll(e, Il(e), u, s);
						break;
					default: throw Error(i(161));
				}
			} catch (t) {
				_f(e, e.return, t);
			}
			e.flags &= -3;
		}
		t & 4096 && (e.flags &= -4097);
	}
	function Nu(e) {
		if (e.subtreeFlags & 1024) for (e = e.child; e !== null;) {
			var t = e;
			Nu(t), t.tag === 5 && t.flags & 1024 && (t = t.stateNode, yh = !0, t.reset(), yh = !1), e = e.sibling;
		}
	}
	function Pu(e, t) {
		if (t.subtreeFlags & 9270) for (t = t.child; t !== null;) Fu(t, e), t = t.sibling;
		else iu(t, !1);
	}
	function Fu(e, t) {
		var n = e.alternate;
		if (n === null) Xl(e, !1);
		else switch (e.tag) {
			case 3:
				if (pu = uu = !1, Wl(), Pu(t, e), !uu && !fu) {
					if (e = Ul, e !== null) for (var r = 0; r < e.length; r += 3) {
						n = e[r];
						var i = e[r + 1];
						jp(n, e[r + 2]), n = n.ownerDocument.documentElement, n !== null && n.animate({
							opacity: [0, 0],
							pointerEvents: ["none", "none"]
						}, {
							duration: 0,
							fill: "forwards",
							pseudoElement: "::view-transition-group(" + i + ")"
						});
					}
					e = t.containerInfo, e = e.nodeType === 9 ? e.documentElement : e.ownerDocument.documentElement, e !== null && e.style.viewTransitionName === "" && (e.style.viewTransitionName = "none", e.animate({
						opacity: [0, 0],
						pointerEvents: ["none", "none"]
					}, {
						duration: 0,
						fill: "forwards",
						pseudoElement: "::view-transition-group(root)"
					}), e.animate({
						width: [0, 0],
						height: [0, 0]
					}, {
						duration: 0,
						fill: "forwards",
						pseudoElement: "::view-transition"
					})), pu = !0;
				}
				Ul = null;
				break;
			case 5:
				Pu(t, e);
				break;
			case 4:
				r = uu, uu = !1, Pu(t, e), uu && (fu = !0), uu = r;
				break;
			case 22:
				e.memoizedState === null && (n.memoizedState === null ? Pu(t, e) : Xl(e, !1));
				break;
			case 30:
				r = uu, i = Wl(), uu = !1, Pu(t, e), uu && (e.flags |= 4);
				var a = e.memoizedProps, o = e.stateNode;
				t = gi(a, o), o = gi(n.memoizedProps, o);
				var s = vi(a.default, a.update);
				s === "none" ? t = !1 : (a = n.memoizedState, n.memoizedState = null, n = e.child, Gl = 0, t = ru(e, n, t, o, s, a, !0), Gl !== (a === null ? 0 : a.length) && (e.flags |= 32)), e.flags & 4 && t ? (Id(e, e.memoizedProps.onUpdate), Ul = i) : i !== null && (i.push.apply(i, Ul), Ul = i), uu = e.flags & 32 ? !0 : r;
				break;
			default: Pu(t, e);
		}
	}
	function Iu(e, t) {
		if (t.subtreeFlags & 8772) for (t = t.child; t !== null;) gu(e, t.alternate, t), t = t.sibling;
	}
	function Lu(e, t) {
		for (e = e.child; e !== null;) {
			var n = e, r = t;
			switch (n.tag) {
				case 0:
				case 11:
				case 14:
				case 15:
					Cl(4, n, n.return), Lu(n, r);
					break;
				case 1:
					Dl(n, n.return);
					var i = n.stateNode;
					typeof i.componentWillUnmount == "function" && Tl(n, n.return, i), Lu(n, r);
					break;
				case 27: r & 2 && xm(n.stateNode, n.type, n.memoizedProps);
				case 5:
					Dl(n, n.return), n.tag !== 5 && n.tag !== 27 || Al(n), Lu(n, r);
					break;
				case 6:
					Al(n);
					break;
				case 26:
					Dl(n, n.return), i = n.stateNode, n.memoizedState !== null || i === null || W || i.parentNode.removeChild(i), Lu(n, r);
					break;
				case 22:
					n.memoizedState === null && Lu(n, r);
					break;
				case 30:
					Dl(n, n.return), Lu(n, r);
					break;
				case 7: Dl(n, n.return);
				default: Lu(n, r);
			}
			e = e.sibling;
		}
	}
	function Ru(e, t, n) {
		for (n = t.subtreeFlags & 8772 ? n : n & -2, t = t.child; t !== null;) {
			var r = t.alternate, i = e, a = t, o = a.flags, s = !!(n & 1);
			switch (a.tag) {
				case 0:
				case 11:
				case 15:
					Ru(i, a, n), Sl(4, a);
					break;
				case 1:
					if (Ru(i, a, n), r = a, i = r.stateNode, typeof i.componentDidMount == "function") try {
						i.componentDidMount();
					} catch (e) {
						_f(r, r.return, e);
					}
					if (r = a, i = r.updateQueue, i !== null) {
						var c = r.stateNode;
						try {
							var l = i.shared.hiddenCallbacks;
							if (l !== null) for (i.shared.hiddenCallbacks = null, i = 0; i < l.length; i++) So(l[i], c);
						} catch (e) {
							_f(r, r.return, e);
						}
					}
					s && o & 64 && wl(a), El(a, a.return);
					break;
				case 27: n & 2 && zl(a);
				case 5:
					a.tag !== 5 && a.tag !== 27 || kl(a), Ru(i, a, n), s && r === null && o & 4 && Nl(a), El(a, a.return);
					break;
				case 6:
					kl(a);
					break;
				case 26:
					c = a.stateNode, a.memoizedState !== null || c === null || au || Ym(Tm(c.ownerDocument), a.type, c), Ru(i, a, n), s && r === null && o & 4 && Nl(a), El(a, a.return);
					break;
				case 12:
					Ru(i, a, n);
					break;
				case 31:
					Ru(i, a, n), s && o & 4 && Tu(i, a);
					break;
				case 13:
					Ru(i, a, n), s && o & 4 && Eu(i, a);
					break;
				case 22:
					a.memoizedState === null && Ru(i, a, n), El(a, a.return);
					break;
				case 30:
					Ru(i, a, n), El(a, a.return);
					break;
				case 7: El(a, a.return);
				default: Ru(i, a, n);
			}
			t = t.sibling;
		}
	}
	function zu(e, t) {
		var n = null;
		e !== null && e.memoizedState !== null && e.memoizedState.cachePool !== null && (n = e.memoizedState.cachePool.pool), e = null, t.memoizedState !== null && t.memoizedState.cachePool !== null && (e = t.memoizedState.cachePool.pool), e !== n && (e != null && e.refCount++, n != null && ja(n));
	}
	function Bu(e, t) {
		e = null, t.alternate !== null && (e = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== e && (t.refCount++, e != null && ja(e));
	}
	function Vu(e, t, n, r) {
		var i = (n & 335544064) === n;
		if (t.subtreeFlags & (i ? 10262 : 10256)) for (t = t.child; t !== null;) Hu(e, t, n, r), t = t.sibling;
		else i && nu(t);
	}
	function Hu(e, t, n, r) {
		var i = (n & 335544064) === n;
		i && t.alternate === null && t.return !== null && t.return.alternate !== null && tu(t);
		var a = t.flags;
		switch (t.tag) {
			case 0:
			case 11:
			case 15:
				Vu(e, t, n, r), a & 2048 && Sl(9, t);
				break;
			case 1:
				Vu(e, t, n, r);
				break;
			case 3:
				Vu(e, t, n, r), i && pu && (e = e.containerInfo, e = e.nodeType === 9 ? e.body : e.nodeName === "HTML" ? e.ownerDocument.body : e, e.style.viewTransitionName === "root" && (e.style.viewTransitionName = ""), e = e.ownerDocument.documentElement, e !== null && e.style.viewTransitionName === "none" && (e.style.viewTransitionName = "")), a & 2048 && (a = null, t.alternate !== null && (a = t.alternate.memoizedState.cache), t = t.memoizedState.cache, t !== a && (t.refCount++, a != null && ja(a)));
				break;
			case 12:
				if (a & 2048) {
					Vu(e, t, n, r), a = t.stateNode;
					try {
						var o = t.memoizedProps, s = o.id, c = o.onPostCommit;
						typeof c == "function" && c(s, t.alternate === null ? "mount" : "update", a.passiveEffectDuration, -0);
					} catch (e) {
						_f(t, t.return, e);
					}
				} else Vu(e, t, n, r);
				break;
			case 31:
				Vu(e, t, n, r);
				break;
			case 13:
				Vu(e, t, n, r);
				break;
			case 23: break;
			case 22:
				o = t.stateNode, s = t.alternate, t.memoizedState === null ? (i && s !== null && s.memoizedState !== null && tu(t), o._visibility & 2 ? Vu(e, t, n, r) : (o._visibility |= 2, Uu(e, t, n, r, !!(t.subtreeFlags & 10256) || !1))) : (i && s !== null && s.memoizedState === null && tu(s), o._visibility & 2 ? Vu(e, t, n, r) : Wu(e, t)), a & 2048 && zu(s, t);
				break;
			case 24:
				Vu(e, t, n, r), a & 2048 && Bu(t.alternate, t);
				break;
			case 30:
				i && (a = t.alternate, a !== null && (Jl(a.child, !0), Jl(t.child, !0))), Vu(e, t, n, r);
				break;
			default: Vu(e, t, n, r);
		}
	}
	function Uu(e, t, n, r, i) {
		for (i &&= !!(t.subtreeFlags & 10256) || !1, t = t.child; t !== null;) {
			var a = e, o = t, s = n, c = r, l = o.flags;
			switch (o.tag) {
				case 0:
				case 11:
				case 15:
					Uu(a, o, s, c, i), Sl(8, o);
					break;
				case 23: break;
				case 22:
					var u = o.stateNode;
					o.memoizedState === null ? (u._visibility |= 2, Uu(a, o, s, c, i)) : u._visibility & 2 ? Uu(a, o, s, c, i) : Wu(a, o), i && l & 2048 && zu(o.alternate, o);
					break;
				case 24:
					Uu(a, o, s, c, i), i && l & 2048 && Bu(o.alternate, o);
					break;
				default: Uu(a, o, s, c, i);
			}
			t = t.sibling;
		}
	}
	function Wu(e, t) {
		if (t.subtreeFlags & 10256) for (t = t.child; t !== null;) {
			var n = e, r = t, i = r.flags;
			switch (r.tag) {
				case 22:
					Wu(n, r), i & 2048 && zu(r.alternate, r);
					break;
				case 24:
					Wu(n, r), i & 2048 && Bu(r.alternate, r);
					break;
				default: Wu(n, r);
			}
			t = t.sibling;
		}
	}
	var Gu = 8192;
	function Ku(e, t, n) {
		if (e.subtreeFlags & Gu) for (e = e.child; e !== null;) qu(e, t, n), e = e.sibling;
	}
	function qu(e, t, n) {
		switch (e.tag) {
			case 26:
				Ku(e, t, n), e.flags & Gu && (e.memoizedState === null ? (e = e.stateNode, (t & 335544128) === t && eh(n, e)) : th(n, Au, e.memoizedState, e.memoizedProps));
				break;
			case 5:
				Ku(e, t, n), e.flags & Gu && (e = e.stateNode, (t & 335544128) === t && eh(n, e));
				break;
			case 3:
			case 4:
				var r = Au;
				Au = Tm(e.stateNode.containerInfo), Ku(e, t, n), Au = r;
				break;
			case 22:
				e.memoizedState === null && (r = e.alternate, r !== null && r.memoizedState !== null ? (r = Gu, Gu = 16777216, Ku(e, t, n), Gu = r) : Ku(e, t, n));
				break;
			case 30:
				if ((e.flags & Gu) !== 0 && (r = e.memoizedProps.name, r != null && r !== "auto")) {
					var i = e.stateNode;
					i.paired = null, Vl === null && (Vl = /* @__PURE__ */ new Map()), Vl.set(r, i);
				}
				Ku(e, t, n);
				break;
			default: Ku(e, t, n);
		}
	}
	function Ju(e) {
		var t = e.alternate;
		if (t !== null && (e = t.child, e !== null)) {
			t.child = null;
			do
				t = e.sibling, e.sibling = null, e = t;
			while (e !== null);
		}
	}
	function Yu(e) {
		var t = e.deletions;
		if (e.flags & 16) {
			if (t !== null) for (var n = 0; n < t.length; n++) {
				var r = t[n];
				lu = r, Qu(r, e);
			}
			Ju(e);
		}
		if (e.subtreeFlags & 10256) for (e = e.child; e !== null;) Xu(e), e = e.sibling;
	}
	function Xu(e) {
		switch (e.tag) {
			case 0:
			case 11:
			case 15:
				Yu(e), e.flags & 2048 && Cl(9, e, e.return);
				break;
			case 3:
				Yu(e);
				break;
			case 12:
				Yu(e);
				break;
			case 22:
				var t = e.stateNode;
				e.memoizedState !== null && t._visibility & 2 && (e.return === null || e.return.tag !== 13) ? (t._visibility &= -3, Zu(e)) : Yu(e);
				break;
			default: Yu(e);
		}
	}
	function Zu(e) {
		var t = e.deletions;
		if (e.flags & 16) {
			if (t !== null) for (var n = 0; n < t.length; n++) {
				var r = t[n];
				lu = r, Qu(r, e);
			}
			Ju(e);
		}
		for (e = e.child; e !== null;) {
			switch (t = e, t.tag) {
				case 0:
				case 11:
				case 15:
					Cl(8, t, t.return), Zu(t);
					break;
				case 22:
					n = t.stateNode, n._visibility & 2 && (n._visibility &= -3, Zu(t));
					break;
				default: Zu(t);
			}
			e = e.sibling;
		}
	}
	function Qu(e, t) {
		for (; lu !== null;) {
			var n = lu;
			switch (n.tag) {
				case 0:
				case 11:
				case 15:
					Cl(8, n, t);
					break;
				case 23:
				case 22:
					if (n.memoizedState !== null && n.memoizedState.cachePool !== null) {
						var r = n.memoizedState.cachePool.pool;
						r != null && r.refCount++;
					}
					break;
				case 24: ja(n.memoizedState.cache);
			}
			if (r = n.child, r !== null) r.return = n, lu = r;
			else a: for (n = e; lu !== null;) {
				r = lu;
				var i = r.sibling, a = r.return;
				if (bu(r), r === n) {
					lu = null;
					break a;
				}
				if (i !== null) {
					i.return = a, lu = i;
					break a;
				}
				lu = a;
			}
		}
	}
	var $u = {
		getCacheForType: function(e) {
			var t = Ca(ka), n = t.data.get(e);
			return n === void 0 && (n = e(), t.data.set(e, n)), n;
		},
		cacheSignal: function() {
			return Ca(ka).controller.signal;
		}
	}, ed = typeof WeakMap == "function" ? WeakMap : Map, G = 0, td = null, K = null, q = 0, nd = 0, rd = null, id = !1, ad = !1, od = !1, sd = 0, cd = 0, ld = 0, ud = 0, dd = 0, fd = 0, pd = 0, md = null, hd = null, gd = !1, _d = 0, vd = 0, yd = Infinity, bd = null, xd = null, Sd = 0, Cd = null, wd = null, Td = 0, Ed = 0, Dd = null, Od = null, kd = null, Ad = null, jd = null, Md = 0, Nd = null;
	function Pd() {
		return G & 2 && q !== 0 ? q & -q : F.T === null ? yt() : Rf();
	}
	function Fd() {
		if (fd === 0) {
			if (!(q & 536870912) || V) {
				var e = rt;
				rt <<= 1, !(rt & 3932160) && (rt = 262144), fd = e;
			} else fd = 536870912;
		}
		return e = ko.current, e !== null && (e.flags |= 32), fd;
	}
	function Id(e, t) {
		if (t != null) {
			var n = e.stateNode, r = n.ref;
			r === null && (r = n.ref = zp(gi(e.memoizedProps, n))), Ad === null && (Ad = []), Ad.push(t.bind(null, r));
		}
	}
	function Ld(e, t, n) {
		(e === td && (nd === 2 || nd === 9) || e.cancelPendingCommit !== null) && (Wd(e, 0), Vd(e, q, fd, !1)), ft(e, n), (!(G & 2) || e !== td) && (e === td && (!(G & 2) && (ud |= n), cd === 4 && Vd(e, q, fd, !1)), Af(e));
	}
	function Rd(e, t, n) {
		if (G & 6) throw Error(i(327));
		var r = !n && !(t & 127) && (t & e.expiredLanes) === 0 || st(e, t), a = r ? Qd(e, t) : Xd(e, t, !0), o = r;
		do {
			if (a === 0) {
				ad && !r && Vd(e, t, 0, !1);
				break;
			}
			if (n = e.current.alternate, o && !Bd(n)) {
				a = Xd(e, t, !1), o = !1;
				continue;
			}
			if (a === 2) {
				if (o = t, e.errorRecoveryDisabledLanes & o) var s = 0;
				else s = e.pendingLanes & -536870913, s = s === 0 ? s & 536870912 ? 536870912 : 0 : s;
				if (s !== 0) {
					t = s;
					a: {
						var c = e;
						a = md;
						var l = c.current.memoizedState.isDehydrated;
						if (l && (Wd(c, s).flags |= 256), s = Xd(c, s, !1), s !== 2 && s !== 6) {
							if (od && !l) {
								c.errorRecoveryDisabledLanes |= o, ud |= o, a = 4;
								break a;
							}
							o = hd, hd = a, o !== null && (hd === null ? hd = o : hd.push.apply(hd, o));
						}
						a = s;
					}
					if (o = !1, a !== 2) continue;
				}
			}
			if (a === 1) {
				Wd(e, 0), Vd(e, t, 0, !0);
				break;
			}
			a: {
				switch (r = e, o = a, o) {
					case 0:
					case 1: throw Error(i(345));
					case 4: if ((t & 4194048) !== t && (t & 62914560) !== t) break;
					case 6:
						Vd(r, t, fd, !id);
						break a;
					case 2:
						hd = null;
						break;
					case 3:
					case 5: break;
					default: throw Error(i(329));
				}
				if ((t & 62914560) === t && (a = _d + 300 - He(), 10 < a)) {
					if (Vd(r, t, fd, !id), ot(r, 0, !0) !== 0) break a;
					Td = t, r.timeoutHandle = xp(zd.bind(null, r, n, hd, bd, gd, t, fd, ud, pd, id, o, "Throttled", -0, 0), a);
					break a;
				}
				zd(r, n, hd, bd, gd, t, fd, ud, pd, id, o, null, -0, 0);
			}
			break;
		} while (1);
		Af(e);
	}
	function zd(e, t, n, r, i, a, o, s, c, l, u, d, f, p) {
		e.timeoutHandle = -1;
		var m = t.subtreeFlags, h = (a & 335544064) === a;
		if (d = null, (h || m & 8192 || (m & 16785408) == 16785408) && (d = {
			stylesheets: null,
			count: 0,
			imgCount: 0,
			imgBytes: 0,
			suspenseyImages: [],
			waitingForImages: !0,
			waitingForViewTransition: !1,
			unsuspend: vn
		}, Vl = null, qu(t, a, d), h && (m = d, h = e.containerInfo, h = (h.nodeType === 9 ? h : h.ownerDocument).__reactViewTransition, h != null && (m.count++, m.waitingForViewTransition = !0, m = ah.bind(m), h.finished.then(m, m))), m = (a & 62914560) === a ? _d - He() : (a & 4194048) === a ? vd - He() : 0, m = rh(d, m), m !== null)) {
			Td = a, e.cancelPendingCommit = m(of.bind(null, e, t, a, n, r, i, o, s, c, l, u, d, null, f, p)), Vd(e, a, o, !l);
			return;
		}
		of(e, t, a, n, r, i, o, s, c, l, u, d);
	}
	function Bd(e) {
		for (var t = e;;) {
			var n = t.tag;
			if ((n === 0 || n === 11 || n === 15) && t.flags & 16384 && (n = t.updateQueue, n !== null && (n = n.stores, n !== null))) for (var r = 0; r < n.length; r++) {
				var i = n[r], a = i.getSnapshot;
				i = i.value;
				try {
					if (!Vr(a(), i)) return !1;
				} catch {
					return !1;
				}
			}
			if (n = t.child, t.subtreeFlags & 16384 && n !== null) n.return = t, t = n;
			else {
				if (t === e) break;
				for (; t.sibling === null;) {
					if (t.return === null || t.return === e) return !0;
					t = t.return;
				}
				t.sibling.return = t.return, t = t.sibling;
			}
		}
		return !0;
	}
	function Vd(e, t, n, r) {
		t = ct(e, t), t &= ~dd, t &= ~ud, e.suspendedLanes |= t, e.pingedLanes &= ~t, r && (e.warmLanes |= t), r = e.expirationTimes;
		for (var i = t; 0 < i;) {
			var a = 31 - $e(i), o = 1 << a;
			r[a] = -1, i &= ~o;
		}
		n !== 0 && mt(e, n, t);
	}
	function Hd() {
		return G & 6 ? !0 : (jf(0, !1), !1);
	}
	function Ud() {
		if (K !== null) {
			if (nd === 0) var e = K.return;
			else e = K, ga = ha = null, is(e), ro = null, io = 0, e = K;
			for (; e !== null;) xl(e.alternate, e), e = e.return;
			K = null;
		}
	}
	function Wd(e, t) {
		var n = e.timeoutHandle;
		return n !== -1 && (e.timeoutHandle = -1, Sp(n)), n = e.cancelPendingCommit, n !== null && (e.cancelPendingCommit = null, n()), Td = 0, Ud(), td = e, K = n = Ni(e.current, null), q = t, nd = 0, rd = null, id = !1, ad = st(e, t), od = !1, pd = fd = dd = ud = ld = cd = 0, hd = md = null, gd = !1, sd = ct(e, t), Ci(), n;
	}
	function Gd(e, t) {
		U = null, F.H = mc, t === qa || t === Ya ? (t = to(), nd = 3) : t === Ja ? (t = to(), nd = 4) : nd = t === Mc ? 8 : typeof t == "object" && t && typeof t.then == "function" ? 6 : 1, rd = t, K === null && (cd = 1, Ec(e, Vi(t, e.current)));
	}
	function Kd() {
		var e = ko.current;
		return e === null ? !0 : (q & 4194048) === q ? Ao === null : (q & 62914560) === q || q & 536870912 ? e === Ao : !1;
	}
	function qd() {
		var e = F.H;
		return F.H = mc, e === null ? mc : e;
	}
	function Jd() {
		var e = F.A;
		return F.A = $u, e;
	}
	function Yd() {
		cd = 4, id || (q & 4194048) !== q && ko.current !== null || (ad = !0), !(ld & 134217727) && !(ud & 134217727) || td === null || Vd(td, q, fd, !1);
	}
	function Xd(e, t, n) {
		var r = G;
		G |= 2;
		var i = qd(), a = Jd();
		(td !== e || q !== t) && (bd = null, Wd(e, t)), t = !1;
		var o = cd;
		a: do
			try {
				if (nd !== 0 && K !== null) {
					var s = K, c = rd;
					switch (nd) {
						case 8:
							Ud(), o = 6;
							break a;
						case 3:
						case 2:
						case 9:
						case 6:
							ko.current === null && (t = !0);
							var l = nd;
							if (nd = 0, rd = null, nf(e, s, c, l), n && ad) {
								o = 0;
								break a;
							}
							break;
						default: l = nd, nd = 0, rd = null, nf(e, s, c, l);
					}
				}
				Zd(), o = cd;
				break;
			} catch (t) {
				Gd(e, t);
			}
		while (1);
		return t && e.shellSuspendCounter++, ga = ha = null, G = r, F.H = i, F.A = a, K === null && (td = null, q = 0, Ci()), o;
	}
	function Zd() {
		for (; K !== null;) ef(K);
	}
	function Qd(e, t) {
		var n = G;
		G |= 2;
		var r = qd(), a = Jd();
		td !== e || q !== t ? (bd = null, yd = He() + 500, Wd(e, t)) : ad = st(e, t);
		a: do
			try {
				if (nd !== 0 && K !== null) {
					t = K;
					var o = rd;
					b: switch (nd) {
						case 1:
							nd = 0, rd = null, nf(e, t, o, 1);
							break;
						case 2:
						case 9:
							if (Za(o)) {
								nd = 0, rd = null, tf(t);
								break;
							}
							t = function() {
								nd !== 2 && nd !== 9 || td !== e || (nd = 7), Af(e);
							}, o.then(t, t);
							break a;
						case 3:
							nd = 7;
							break a;
						case 4:
							nd = 5;
							break a;
						case 7:
							Za(o) ? (nd = 0, rd = null, tf(t)) : (nd = 0, rd = null, nf(e, t, o, 7));
							break;
						case 5:
							var s = null;
							switch (K.tag) {
								case 26: s = K.memoizedState;
								case 5:
								case 27:
									var c = K;
									if (s ? Qm(s) : c.stateNode.complete) {
										nd = 0, rd = null;
										var l = c.sibling;
										if (l !== null) K = l;
										else {
											var u = c.return;
											u === null ? K = null : (K = u, rf(u));
										}
										break b;
									}
							}
							nd = 0, rd = null, nf(e, t, o, 5);
							break;
						case 6:
							nd = 0, rd = null, nf(e, t, o, 6);
							break;
						case 8:
							Ud(), cd = 6;
							break a;
						default: throw Error(i(462));
					}
				}
				$d();
				break;
			} catch (t) {
				Gd(e, t);
			}
		while (1);
		return ga = ha = null, F.H = r, F.A = a, G = n, K === null ? (td = null, q = 0, Ci(), cd) : 0;
	}
	function $d() {
		for (; K !== null && !Be();) ef(K);
	}
	function ef(e) {
		var t = fl(e.alternate, e, sd);
		e.memoizedProps = e.pendingProps, t === null ? rf(e) : K = t;
	}
	function tf(e) {
		var t = e, n = t.alternate;
		switch (t.tag) {
			case 15:
			case 0:
				t = Kc(n, t, t.pendingProps, t.type, void 0, q);
				break;
			case 11:
				t = Kc(n, t, t.pendingProps, t.type.render, t.ref, q);
				break;
			case 5:
				is(t);
				var r = t;
				r === na && (V ? (la(r), r.tag === 5 && r.stateNode != null && (ra = r.stateNode)) : (la(r), V = !0));
			default: xl(n, t), t = K = Pi(t, sd), t = fl(n, t, sd);
		}
		e.memoizedProps = e.pendingProps, t === null ? rf(e) : K = t;
	}
	function nf(e, t, n, r) {
		ga = ha = null, is(t), ro = null, io = 0;
		var i = t.return;
		try {
			if (jc(e, i, t, n, q)) {
				cd = 1, Ec(e, Vi(n, e.current)), K = null;
				return;
			}
		} catch (t) {
			if (i !== null) throw K = i, t;
			cd = 1, Ec(e, Vi(n, e.current)), K = null;
			return;
		}
		t.flags & 32768 ? (V || r === 1 ? e = !0 : ad || q & 536870912 ? e = !1 : (id = e = !0, (r === 2 || r === 9 || r === 3 || r === 6) && (r = ko.current, r !== null && r.tag === 13 && (r.flags |= 16384))), af(t, e)) : rf(t);
	}
	function rf(e) {
		var t = e;
		do {
			if (t.flags & 32768) {
				af(t, id);
				return;
			}
			e = t.return;
			var n = yl(t.alternate, t, sd);
			if (n !== null) {
				K = n;
				return;
			}
			if (t = t.sibling, t !== null) {
				K = t;
				return;
			}
			K = t = e;
		} while (t !== null);
		cd === 0 && (cd = 5);
	}
	function af(e, t) {
		do {
			var n = bl(e.alternate, e);
			if (n !== null) {
				n.flags &= 32767, K = n;
				return;
			}
			if (n = e.return, n !== null && (n.flags |= 32768, n.subtreeFlags = 0, n.deletions = null), !t && (e = e.sibling, e !== null)) {
				K = e;
				return;
			}
			K = e = n;
		} while (e !== null);
		cd = 6, K = null;
	}
	function of(e, t, n, r, a, o, s, c, l, u, d, f) {
		e.cancelPendingCommit = null;
		do
			mf();
		while (Sd !== 0);
		if (G & 6) throw Error(i(327));
		if (t !== null) {
			if (t === e.current) throw Error(i(177));
			e === td && (K = td = null, q = 0), wd = t, Cd = e, Td = n, Dd = a, Od = r, sf(e, t, n, s, c, l, f);
		}
	}
	function sf(e, t, n, r, i, a, o) {
		var s = t.lanes | t.childLanes;
		if (Ed = s, s |= Si, pt(e, n, s, r, i, a), Ad = null, (n & 335544064) === n ? (jd = Pa(e), r = 10262) : (jd = null, r = 10256), (t.subtreeFlags & r) !== 0 || (t.flags & r) !== 0 ? (e.callbackNode = null, e.callbackPriority = 0, Cf(Ke, function() {
			return hf(), null;
		})) : (e.callbackNode = null, e.callbackPriority = 0), Bl = !1, r = !!(t.flags & 13878), t.subtreeFlags & 13878 || r) {
			r = F.T, F.T = null, i = I.p, I.p = 2, a = G, G |= 4;
			try {
				mu(e, t, n);
			} finally {
				G = a, I.p = i, F.T = r;
			}
		}
		Sd = 1, Bl ? kd = Lp(o, e.containerInfo, jd, uf, df, lf, ff, hf, cf, null, null) : (uf(), df(), ff());
	}
	function cf(e) {
		if (Sd !== 0) {
			var t = Cd.onRecoverableError;
			t(e, { componentStack: null });
		}
	}
	function lf() {
		Sd === 3 && (Sd = 0, Fu(wd, Cd), Sd = 4);
	}
	function uf() {
		if (Sd === 1) {
			Sd = 0;
			var e = Cd, t = wd, n = Td, r = !!(t.flags & 13878);
			if (t.subtreeFlags & 13878 || r) {
				r = F.T, F.T = null;
				var i = I.p;
				I.p = 2;
				var a = G;
				G |= 4;
				try {
					du = fu = !1, ju(t, e, n), n = pp;
					var o = qr(e.containerInfo), s = n.focusedElem, c = n.selectionRange;
					if (o !== s && s && s.ownerDocument && Kr(s.ownerDocument.documentElement, s)) {
						if (c !== null && Jr(s)) {
							var l = c.start, u = c.end;
							if (u === void 0 && (u = l), "selectionStart" in s) s.selectionStart = l, s.selectionEnd = Math.min(u, s.value.length);
							else {
								var d = s.ownerDocument || document, f = d && d.defaultView || window;
								if (f.getSelection) {
									var p = f.getSelection(), m = s.textContent.length, h = Math.min(c.start, m), g = c.end === void 0 ? h : Math.min(c.end, m);
									!p.extend && h > g && (o = g, g = h, h = o);
									var _ = Gr(s, h), v = Gr(s, g);
									if (_ && v && (p.rangeCount !== 1 || p.anchorNode !== _.node || p.anchorOffset !== _.offset || p.focusNode !== v.node || p.focusOffset !== v.offset)) {
										var y = d.createRange();
										y.setStart(_.node, _.offset), p.removeAllRanges(), h > g ? (p.addRange(y), p.extend(v.node, v.offset)) : (y.setEnd(v.node, v.offset), p.addRange(y));
									}
								}
							}
						}
						for (d = [], p = s; p = p.parentNode;) p.nodeType === 1 && d.push({
							element: p,
							left: p.scrollLeft,
							top: p.scrollTop
						});
						for (typeof s.focus == "function" && s.focus(), s = 0; s < d.length; s++) {
							var b = d[s];
							b.element.scrollLeft = b.left, b.element.scrollTop = b.top;
						}
					}
					yh = !!fp, pp = fp = null;
				} finally {
					G = a, I.p = i, F.T = r;
				}
			}
			e.current = t, Sd = 2;
		}
	}
	function df() {
		if (Sd === 2) {
			Sd = 0;
			var e = Cd, t = wd, n = !!(t.flags & 8772);
			if (t.subtreeFlags & 8772 || n) {
				n = F.T, F.T = null;
				var r = I.p;
				I.p = 2;
				var i = G;
				G |= 4;
				try {
					gu(e, t.alternate, t);
				} finally {
					G = i, I.p = r, F.T = n;
				}
			}
			Sd = 3;
		}
	}
	function ff() {
		if (Sd === 4 || Sd === 3) {
			Sd = 0;
			var e = kd;
			kd = null, Ve();
			var t = Cd, n = wd, r = Td, i = Od, a = (r & 335544064) === r ? 10262 : 10256;
			if ((n.subtreeFlags & a) !== 0 || (n.flags & a) !== 0 ? Sd = 5 : (Sd = 0, wd = Cd = null, pf(t, t.pendingLanes)), a = t.pendingLanes, a === 0 && (xd = null), vt(r), n = n.stateNode, L && typeof L.onCommitFiberRoot == "function") try {
				L.onCommitFiberRoot(Ze, n, void 0, (n.current.flags & 128) == 128);
			} catch {}
			if (i !== null) {
				n = F.T, a = I.p, I.p = 2, F.T = null;
				try {
					for (var o = t.onRecoverableError, s = 0; s < i.length; s++) {
						var c = i[s];
						o(c.value, { componentStack: c.stack });
					}
				} finally {
					F.T = n, I.p = a;
				}
			}
			if (i = Ad, o = jd, jd = null, i !== null && (Ad = null, o === null && (o = []), e !== null)) for (c = 0; c < i.length; c++) n = (0, i[c])(o), n !== void 0 && e.finished.finally(n);
			Td & 3 && mf(), Af(t), a = t.pendingLanes, r & 261930 && a & 42 ? t === Nd ? Md++ : (Md = 0, Nd = t) : (Md = 0, Nd = null), jf(0, !1);
		}
	}
	function pf(e, t) {
		(e.pooledCacheLanes &= t) === 0 && (t = e.pooledCache, t != null && (e.pooledCache = null, ja(t)));
	}
	function mf() {
		return kd !== null && (kd.skipTransition(), kd = null), uf(), df(), ff(), hf();
	}
	function hf() {
		if (Sd !== 5) return !1;
		var e = Cd, t = Ed;
		Ed = 0;
		var n = vt(Td), r = F.T, a = I.p;
		try {
			I.p = 32 > n ? 32 : n, F.T = null, n = Dd, Dd = null;
			var o = Cd, s = Td;
			if (Sd = 0, wd = Cd = null, Td = 0, G & 6) throw Error(i(331));
			var c = G;
			if (G |= 4, Xu(o.current), Hu(o, o.current, s, n), G = c, jf(0, !1), L && typeof L.onPostCommitFiberRoot == "function") try {
				L.onPostCommitFiberRoot(Ze, o);
			} catch {}
			return !0;
		} finally {
			I.p = a, F.T = r, pf(e, t);
		}
	}
	function gf(e, t, n) {
		t = Vi(n, t), t = Oc(e.stateNode, t, 2), e = go(e, t, 2), e !== null && (ft(e, 2), Af(e));
	}
	function _f(e, t, n) {
		if (e.tag === 3) gf(e, e, n);
		else for (; t !== null;) {
			if (t.tag === 3) {
				gf(t, e, n);
				break;
			}
			if (t.tag === 1) {
				var r = t.stateNode;
				if (typeof t.type.getDerivedStateFromError == "function" || typeof r.componentDidCatch == "function" && (xd === null || !xd.has(r))) {
					e = Vi(n, e), n = kc(2), r = go(t, n, 2), r !== null && (Ac(n, r, t, e), ft(r, 2), Af(r));
					break;
				}
			}
			t = t.return;
		}
	}
	function vf(e, t, n) {
		var r = e.pingCache;
		if (r === null) {
			r = e.pingCache = new ed();
			var i = /* @__PURE__ */ new Set();
			r.set(t, i);
		} else i = r.get(t), i === void 0 && (i = /* @__PURE__ */ new Set(), r.set(t, i));
		i.has(n) || (od = !0, i.add(n), e = yf.bind(null, e, t, n), t.then(e, e));
	}
	function yf(e, t, n) {
		var r = e.pingCache;
		r !== null && r.delete(t), e.pingedLanes |= e.suspendedLanes & n, e.warmLanes &= ~n, td === e && (q & n) === n && (cd === 4 || cd === 3 && (q & 62914560) === q && 300 > He() - _d ? G & 2 ? dd |= n : Wd(e, 0) : dd |= n, pd === q && (pd = 0)), Af(e);
	}
	function bf(e, t) {
		t === 0 && (t = ut()), e = Ei(e, t), e !== null && (ft(e, t), Af(e));
	}
	function xf(e) {
		var t = e.memoizedState, n = 0;
		t !== null && (n = t.retryLane), bf(e, n);
	}
	function Sf(e, t) {
		var n = 0;
		switch (e.tag) {
			case 31:
			case 13:
				var r = e.stateNode, a = e.memoizedState;
				a !== null && (n = a.retryLane);
				break;
			case 19:
				r = e.stateNode;
				break;
			case 22:
				r = e.stateNode._retryCache;
				break;
			default: throw Error(i(314));
		}
		r !== null && r.delete(t), bf(e, n);
	}
	function Cf(e, t) {
		return Re(e, t);
	}
	var wf = null, Tf = null, Ef = !1, Df = !1, Of = !1, kf = 0;
	function Af(e) {
		e !== Tf && e.next === null && (Tf === null ? wf = Tf = e : Tf = Tf.next = e), Df = !0, Ef || (Ef = !0, Lf());
	}
	function jf(e, t) {
		if (!Of && Df) {
			Of = !0;
			do
				for (var n = !1, r = wf; r !== null;) {
					if (!t) {
						if (e !== 0) {
							var i = r.pendingLanes;
							if (i === 0) var a = 0;
							else {
								var o = r.suspendedLanes, s = r.pingedLanes;
								a = (1 << 31 - $e(42 | e) + 1) - 1, a &= i & ~(o & ~s), a = a & 201326741 ? a & 201326741 | 1 : a ? a | 2 : 0;
							}
							a !== 0 && (n = !0, If(r, a));
						} else a = q, a = ot(r, r === td ? a : 0, r.cancelPendingCommit !== null || r.timeoutHandle !== -1), !(a & 3) || st(r, a) || (n = !0, If(r, a));
					}
					r = r.next;
				}
			while (n);
			Of = !1;
		}
	}
	function Mf() {
		Nf();
	}
	function Nf() {
		Df = Ef = !1;
		var e = 0;
		kf !== 0 && bp() && (e = kf);
		for (var t = He(), n = null, r = wf; r !== null;) {
			var i = r.next, a = Pf(r, t);
			a === 0 ? (r.next = null, n === null ? wf = i : n.next = i, i === null && (Tf = n)) : (n = r, (e !== 0 || a & 3) && (Df = !0)), r = i;
		}
		Sd !== 0 && Sd !== 5 || jf(e, !1), kf !== 0 && (kf = 0);
	}
	function Pf(e, t) {
		for (var n = e.suspendedLanes, r = e.pingedLanes, i = e.expirationTimes, a = e.pendingLanes & -62914561; 0 < a;) {
			var o = 31 - $e(a), s = 1 << o, c = i[o];
			c === -1 ? ((s & n) === 0 || (s & r) !== 0) && (i[o] = lt(s, t)) : c <= t && (e.expiredLanes |= s), a &= ~s;
		}
		if (t = td, n = q, n = ot(e, e === t ? n : 0, e.cancelPendingCommit !== null || e.timeoutHandle !== -1), r = e.callbackNode, n === 0 || e === t && (nd === 2 || nd === 9) || e.cancelPendingCommit !== null) return r !== null && r !== null && ze(r), e.callbackNode = null, e.callbackPriority = 0;
		if (!(n & 3) || st(e, n)) {
			if (t = n & -n, t === e.callbackPriority) return t;
			switch (r !== null && ze(r), vt(n)) {
				case 2:
				case 8:
					n = Ge;
					break;
				case 32:
					n = Ke;
					break;
				case 268435456:
					n = Je;
					break;
				default: n = Ke;
			}
			return r = Ff.bind(null, e), n = Re(n, r), e.callbackPriority = t, e.callbackNode = n, t;
		}
		return r !== null && r !== null && ze(r), e.callbackPriority = 2, e.callbackNode = null, 2;
	}
	function Ff(e, t) {
		if (Sd !== 0 && Sd !== 5) return e.callbackNode = null, e.callbackPriority = 0, null;
		var n = e.callbackNode;
		if (mf() && e.callbackNode !== n) return null;
		var r = q;
		return r = ot(e, e === td ? r : 0, e.cancelPendingCommit !== null || e.timeoutHandle !== -1), r === 0 ? null : (Rd(e, r, t), Pf(e, He()), e.callbackNode != null && e.callbackNode === n ? Ff.bind(null, e) : null);
	}
	function If(e, t) {
		if (mf()) return null;
		Rd(e, t, !0);
	}
	function Lf() {
		Tp(function() {
			G & 6 ? Re(We, Mf) : Nf();
		});
	}
	function Rf() {
		if (kf === 0) {
			var e = La;
			e === 0 && (e = R, R <<= 1, !(R & 261888) && (R = 256)), kf = e;
		}
		return kf;
	}
	function zf(e) {
		return e == null || typeof e == "symbol" || typeof e == "boolean" ? null : typeof e == "function" ? e : _n(e);
	}
	function Bf(e, t, n, r, i) {
		if (t === "submit" && n && n.stateNode === i) {
			var a = zf((i[Ct] || null).action), o = r.submitter;
			o && (t = (t = o[Ct] || null) ? zf(t.formAction) : o.getAttribute("formAction"), t !== null && (a = t, o = null));
			var s = new zn("action", "action", null, r, i);
			e.push({
				event: s,
				listeners: [{
					instance: null,
					listener: function() {
						if (r.defaultPrevented) {
							if (kf !== 0) {
								var e = new FormData(i, o);
								ec(n, {
									pending: !0,
									data: e,
									method: i.method,
									action: a
								}, null, e);
							}
						} else typeof a == "function" && (s.preventDefault(), e = new FormData(i, o), ec(n, {
							pending: !0,
							data: e,
							method: i.method,
							action: a
						}, a, e));
					},
					currentTarget: i
				}]
			});
		}
	}
	for (var Vf = 0; Vf < pi.length; Vf++) {
		var Hf = pi[Vf];
		mi(Hf.toLowerCase(), "on" + (Hf[0].toUpperCase() + Hf.slice(1)));
	}
	mi(ai, "onAnimationEnd"), mi(oi, "onAnimationIteration"), mi(si, "onAnimationStart"), mi("dblclick", "onDoubleClick"), mi("focusin", "onFocus"), mi("focusout", "onBlur"), mi(ci, "onTransitionRun"), mi(li, "onTransitionStart"), mi(ui, "onTransitionCancel"), mi(di, "onTransitionEnd"), Vt("onMouseEnter", ["mouseout", "mouseover"]), Vt("onMouseLeave", ["mouseout", "mouseover"]), Vt("onPointerEnter", ["pointerout", "pointerover"]), Vt("onPointerLeave", ["pointerout", "pointerover"]), Bt("onChange", "change click focusin focusout input keydown keyup selectionchange".split(" ")), Bt("onSelect", "focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" ")), Bt("onBeforeInput", [
		"compositionend",
		"keypress",
		"textInput",
		"paste"
	]), Bt("onCompositionEnd", "compositionend focusout keydown keypress keyup mousedown".split(" ")), Bt("onCompositionStart", "compositionstart focusout keydown keypress keyup mousedown".split(" ")), Bt("onCompositionUpdate", "compositionupdate focusout keydown keypress keyup mousedown".split(" "));
	var Uf = "abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "), Wf = new Set("beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(Uf));
	function Gf(e, t) {
		t = !!(t & 4);
		for (var n = 0; n < e.length; n++) {
			var r = e[n], i = r.event;
			r = r.listeners;
			a: {
				var a = void 0;
				if (t) for (var o = r.length - 1; 0 <= o; o--) {
					var s = r[o], c = s.instance, l = s.currentTarget;
					if (s = s.listener, c !== a && i.isPropagationStopped()) break a;
					a = s, i.currentTarget = l;
					try {
						a(i);
					} catch (e) {
						yi(e);
					}
					i.currentTarget = null, a = c;
				}
				else for (o = 0; o < r.length; o++) {
					if (s = r[o], c = s.instance, l = s.currentTarget, s = s.listener, c !== a && i.isPropagationStopped()) break a;
					a = s, i.currentTarget = l;
					try {
						a(i);
					} catch (e) {
						yi(e);
					}
					i.currentTarget = null, a = c;
				}
			}
		}
	}
	function J(e, t) {
		var n = t[Tt];
		n === void 0 && (n = t[Tt] = /* @__PURE__ */ new Set());
		var r = e + "__bubble";
		n.has(r) || (Yf(t, e, 2, !1), n.add(r));
	}
	function Kf(e, t, n) {
		var r = 0;
		t && (r |= 4), Yf(n, e, r, t);
	}
	var qf = "_reactListening" + Math.random().toString(36).slice(2);
	function Jf(e) {
		if (!e[qf]) {
			e[qf] = !0, Rt.forEach(function(t) {
				t !== "selectionchange" && (Wf.has(t) || Kf(t, !1, e), Kf(t, !0, e));
			});
			var t = e.nodeType === 9 ? e : e.ownerDocument;
			t === null || t[qf] || (t[qf] = !0, Kf("selectionchange", !1, t));
		}
	}
	function Yf(e, t, n, r) {
		switch (Eh(t)) {
			case 2:
				var i = bh;
				break;
			case 8:
				i = xh;
				break;
			default: i = Sh;
		}
		n = i.bind(null, t, n, e), i = void 0, !On || t !== "touchstart" && t !== "touchmove" && t !== "wheel" || (i = !0), r ? i === void 0 ? e.addEventListener(t, n, !0) : e.addEventListener(t, n, {
			capture: !0,
			passive: i
		}) : i === void 0 ? e.addEventListener(t, n, !1) : e.addEventListener(t, n, { passive: i });
	}
	function Xf(e, t, n, r, i) {
		var a = r;
		if (!(t & 1) && !(t & 2) && r !== null) a: for (;;) {
			if (r === null) return;
			var s = r.tag;
			if (s === 3 || s === 4) {
				var c = r.stateNode.containerInfo;
				if (c === i) break;
				if (s === 4) for (s = r.return; s !== null;) {
					var l = s.tag;
					if ((l === 3 || l === 4) && s.stateNode.containerInfo === i) return;
					s = s.return;
				}
				for (; c !== null;) {
					if (s = Mt(c), s === null) return;
					if (l = s.tag, l === 5 || l === 6 || l === 26 || l === 27) {
						r = a = s;
						continue a;
					}
					c = c.parentNode;
				}
			}
			r = r.return;
		}
		Tn(function() {
			var r = a, i = bn(n), s = [];
			a: {
				var c = fi.get(e);
				if (c !== void 0) {
					var l = zn, u = e;
					switch (e) {
						case "keypress": if (Pn(n) === 0) break a;
						case "keydown":
						case "keyup":
							l = rr;
							break;
						case "focusin":
							u = "focus", l = Jn;
							break;
						case "focusout":
							u = "blur", l = Jn;
							break;
						case "beforeblur":
						case "afterblur":
							l = Jn;
							break;
						case "click": if (n.button === 2) break a;
						case "auxclick":
						case "dblclick":
						case "mousedown":
						case "mousemove":
						case "mouseup":
						case "mouseout":
						case "mouseover":
						case "contextmenu":
							l = Kn;
							break;
						case "drag":
						case "dragend":
						case "dragenter":
						case "dragexit":
						case "dragleave":
						case "dragover":
						case "dragstart":
						case "drop":
							l = qn;
							break;
						case "touchcancel":
						case "touchend":
						case "touchmove":
						case "touchstart":
							l = or;
							break;
						case ai:
						case oi:
						case si:
							l = Yn;
							break;
						case di:
							l = sr;
							break;
						case "scroll":
						case "scrollend":
							l = Vn;
							break;
						case "wheel":
							l = cr;
							break;
						case "copy":
						case "cut":
						case "paste":
							l = Xn;
							break;
						case "gotpointercapture":
						case "lostpointercapture":
						case "pointercancel":
						case "pointerdown":
						case "pointermove":
						case "pointerout":
						case "pointerover":
						case "pointerup":
							l = ir;
							break;
						case "submit":
							l = ar;
							break;
						case "toggle":
						case "beforetoggle": l = lr;
					}
					var d = !!(t & 4), f = !d && (e === "scroll" || e === "scrollend"), p = d ? c === null ? null : c + "Capture" : c;
					d = [];
					for (var m = r, h; m !== null;) {
						var g = m;
						if (h = g.stateNode, g = g.tag, g !== 5 && g !== 26 && g !== 27 || h === null || p === null || (g = En(m, p), g != null && d.push(Zf(m, g, h))), f) break;
						m = m.return;
					}
					0 < d.length && (c = new l(c, u, null, n, i), s.push({
						event: c,
						listeners: d
					}));
				}
			}
			if (!(t & 7)) {
				a: {
					if (l = e === "mouseover" || e === "pointerover", c = e === "mouseout" || e === "pointerout", l && n !== yn && (u = n.relatedTarget || n.fromElement) && (Mt(u) || u[wt])) break a;
					(c || l) && (u = i.window === i ? i : (l = i.ownerDocument) ? l.defaultView || l.parentWindow : window, c ? (l = n.relatedTarget || n.toElement, c = r, l = l ? Mt(l) : null, l !== null && (f = o(l), d = l.tag, l !== f || d !== 5 && d !== 27 && d !== 6) && (l = null)) : (c = null, l = r), c !== l && (d = Kn, g = "onMouseLeave", p = "onMouseEnter", m = "mouse", (e === "pointerout" || e === "pointerover") && (d = ir, g = "onPointerLeave", p = "onPointerEnter", m = "pointer"), f = c == null ? u : Pt(c), h = l == null ? u : Pt(l), u = new d(g, m + "leave", c, n, i), u.target = f, u.relatedTarget = h, g = null, Mt(i) === r && (d = new d(p, m + "enter", l, n, i), d.target = h, d.relatedTarget = f, g = d), f = g, d = c && l ? E(c, l, $f) : null, c !== null && ep(s, u, c, d, !1), l !== null && f !== null && ep(s, f, l, d, !0)));
				}
				a: {
					if (c = r ? Pt(r) : window, l = c.nodeName && c.nodeName.toLowerCase(), l === "select" || l === "input" && c.type === "file") var _ = kr;
					else if (Cr(c)) {
						if (Ar) _ = zr;
						else {
							_ = Lr;
							var v = Ir;
						}
					} else l = c.nodeName, !l || l.toLowerCase() !== "input" || c.type !== "checkbox" && c.type !== "radio" ? r && mn(r.elementType) && (_ = kr) : _ = Rr;
					if (_ &&= _(e, r)) {
						wr(s, _, n, i);
						break a;
					}
					v && v(e, c, r);
				}
				switch (v = r ? Pt(r) : window, e) {
					case "focusin":
						(Cr(v) || v.contentEditable === "true") && (Xr = v, Zr = r, B = null);
						break;
					case "focusout":
						B = Zr = Xr = null;
						break;
					case "mousedown":
						Qr = !0;
						break;
					case "contextmenu":
					case "mouseup":
					case "dragend":
						Qr = !1, $r(s, n, i);
						break;
					case "selectionchange": if (Yr) break;
					case "keydown":
					case "keyup": $r(s, n, i);
				}
				var y;
				if (dr) b: {
					switch (e) {
						case "compositionstart":
							var b = "onCompositionStart";
							break b;
						case "compositionend":
							b = "onCompositionEnd";
							break b;
						case "compositionupdate":
							b = "onCompositionUpdate";
							break b;
					}
					b = void 0;
				}
				else yr ? _r(e, n) && (b = "onCompositionEnd") : e === "keydown" && n.keyCode === 229 && (b = "onCompositionStart");
				b && (mr && n.locale !== "ko" && (yr || b !== "onCompositionStart" ? b === "onCompositionEnd" && yr && (y = Nn()) : (An = i, jn = "value" in An ? An.value : An.textContent, yr = !0)), v = Qf(r, b), 0 < v.length && (b = new Zn(b, e, null, n, i), s.push({
					event: b,
					listeners: v
				}), y ? b.data = y : (y = vr(n), y !== null && (b.data = y)))), (y = pr ? br(e, n) : xr(e, n)) && (b = Qf(r, "onBeforeInput"), 0 < b.length && (v = new Zn("onBeforeInput", "beforeinput", null, n, i), s.push({
					event: v,
					listeners: b
				}), v.data = y)), Bf(s, e, r, n, i);
			}
			Gf(s, t);
		});
	}
	function Zf(e, t, n) {
		return {
			instance: e,
			listener: t,
			currentTarget: n
		};
	}
	function Qf(e, t) {
		for (var n = t + "Capture", r = []; e !== null;) {
			var i = e, a = i.stateNode;
			if (i = i.tag, i !== 5 && i !== 26 && i !== 27 || a === null || (i = En(e, n), i != null && r.unshift(Zf(e, i, a)), i = En(e, t), i != null && r.push(Zf(e, i, a))), e.tag === 3) return r;
			e = e.return;
		}
		return [];
	}
	function $f(e) {
		if (e === null) return null;
		do
			e = e.return;
		while (e && e.tag !== 5 && e.tag !== 27);
		return e || null;
	}
	function ep(e, t, n, r, i) {
		for (var a = t._reactName, o = []; n !== null && n !== r;) {
			var s = n, c = s.alternate, l = s.stateNode;
			if (s = s.tag, c !== null && c === r) break;
			s !== 5 && s !== 26 && s !== 27 || l === null || (c = l, i ? (l = En(n, a), l != null && o.unshift(Zf(n, l, c))) : i || (l = En(n, a), l != null && o.push(Zf(n, l, c)))), n = n.return;
		}
		o.length !== 0 && e.push({
			event: t,
			listeners: o
		});
	}
	var tp = /\r\n?/g, np = /\u0000|\uFFFD/g;
	function rp(e) {
		return (typeof e == "string" ? e : "" + e).replace(tp, "\n").replace(np, "");
	}
	function ip(e, t) {
		return t = rp(t), rp(e) === t;
	}
	function ap(e, t, n, r, a, o) {
		switch (n) {
			case "children":
				if (typeof r == "string") t === "body" || t === "textarea" && r === "" || un(e, r);
				else if (typeof r == "number" || typeof r == "bigint") t !== "body" && un(e, "" + r);
				else return;
				break;
			case "className":
				Jt(e, "class", r);
				break;
			case "tabIndex":
				Jt(e, "tabindex", r);
				break;
			case "dir":
			case "role":
			case "viewBox":
			case "width":
			case "height":
				Jt(e, n, r);
				break;
			case "style":
				pn(e, r, o);
				return;
			case "data": if (t !== "object") {
				Jt(e, "data", r);
				break;
			}
			case "src":
			case "href":
				if (r === "" && (t !== "a" || n !== "href")) {
					e.removeAttribute(n);
					break;
				}
				if (r == null || typeof r == "function" || typeof r == "symbol" || typeof r == "boolean") {
					e.removeAttribute(n);
					break;
				}
				r = _n(r), e.setAttribute(n, r);
				break;
			case "action":
			case "formAction":
				if (typeof r == "function") {
					e.setAttribute(n, "javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')");
					break;
				}
				if (typeof o == "function" && (n === "formAction" ? (t !== "input" && ap(e, t, "name", a.name, a, null), ap(e, t, "formEncType", a.formEncType, a, null), ap(e, t, "formMethod", a.formMethod, a, null), ap(e, t, "formTarget", a.formTarget, a, null)) : (ap(e, t, "encType", a.encType, a, null), ap(e, t, "method", a.method, a, null), ap(e, t, "target", a.target, a, null))), r == null || typeof r == "symbol" || typeof r == "boolean") {
					e.removeAttribute(n);
					break;
				}
				r = _n(r), e.setAttribute(n, r);
				break;
			case "onClick":
				r != null && (e.onclick = vn);
				return;
			case "onScroll":
				r != null && J("scroll", e);
				return;
			case "onScrollEnd":
				r != null && J("scrollend", e);
				return;
			case "dangerouslySetInnerHTML":
				if (r != null) {
					if (typeof r != "object" || !("__html" in r)) throw Error(i(61));
					if (n = r.__html, n != null) {
						if (a.children != null) throw Error(i(60));
						o?.__html !== n && (e.innerHTML = n);
					}
				}
				break;
			case "multiple":
				e.multiple = r && typeof r != "function" && typeof r != "symbol";
				break;
			case "muted":
				e.muted = r && typeof r != "function" && typeof r != "symbol";
				break;
			case "suppressContentEditableWarning":
			case "suppressHydrationWarning":
			case "defaultValue":
			case "defaultChecked":
			case "innerHTML":
			case "ref": break;
			case "autoFocus": break;
			case "xlinkHref":
				if (r == null || typeof r == "function" || typeof r == "boolean" || typeof r == "symbol") {
					e.removeAttribute("xlink:href");
					break;
				}
				n = _n(r), e.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", n);
				break;
			case "contentEditable":
			case "spellCheck":
			case "draggable":
			case "value":
			case "autoReverse":
			case "externalResourcesRequired":
			case "focusable":
			case "preserveAlpha":
				r != null && typeof r != "function" && typeof r != "symbol" ? e.setAttribute(n, r) : e.removeAttribute(n);
				break;
			case "inert":
			case "allowFullScreen":
			case "async":
			case "autoPlay":
			case "controls":
			case "credentialless":
			case "default":
			case "defer":
			case "disabled":
			case "disablePictureInPicture":
			case "disableRemotePlayback":
			case "formNoValidate":
			case "hidden":
			case "loop":
			case "noModule":
			case "noValidate":
			case "open":
			case "playsInline":
			case "readOnly":
			case "required":
			case "reversed":
			case "scoped":
			case "seamless":
			case "itemScope":
				r && typeof r != "function" && typeof r != "symbol" ? e.setAttribute(n, "") : e.removeAttribute(n);
				break;
			case "capture":
			case "download":
				!0 === r ? e.setAttribute(n, "") : !1 !== r && r != null && typeof r != "function" && typeof r != "symbol" ? e.setAttribute(n, r) : e.removeAttribute(n);
				break;
			case "cols":
			case "rows":
			case "size":
			case "span":
				r != null && typeof r != "function" && typeof r != "symbol" && !isNaN(r) && 1 <= r ? e.setAttribute(n, r) : e.removeAttribute(n);
				break;
			case "rowSpan":
			case "start":
				r == null || typeof r == "function" || typeof r == "symbol" || isNaN(r) ? e.removeAttribute(n) : e.setAttribute(n, r);
				break;
			case "popover":
				J("beforetoggle", e), J("toggle", e), qt(e, "popover", r);
				break;
			case "xlinkActuate":
				Yt(e, "http://www.w3.org/1999/xlink", "xlink:actuate", r);
				break;
			case "xlinkArcrole":
				Yt(e, "http://www.w3.org/1999/xlink", "xlink:arcrole", r);
				break;
			case "xlinkRole":
				Yt(e, "http://www.w3.org/1999/xlink", "xlink:role", r);
				break;
			case "xlinkShow":
				Yt(e, "http://www.w3.org/1999/xlink", "xlink:show", r);
				break;
			case "xlinkTitle":
				Yt(e, "http://www.w3.org/1999/xlink", "xlink:title", r);
				break;
			case "xlinkType":
				Yt(e, "http://www.w3.org/1999/xlink", "xlink:type", r);
				break;
			case "xmlBase":
				Yt(e, "http://www.w3.org/XML/1998/namespace", "xml:base", r);
				break;
			case "xmlLang":
				Yt(e, "http://www.w3.org/XML/1998/namespace", "xml:lang", r);
				break;
			case "xmlSpace":
				Yt(e, "http://www.w3.org/XML/1998/namespace", "xml:space", r);
				break;
			case "is":
				qt(e, "is", r);
				break;
			case "innerText":
			case "textContent": return;
			default: if (!(2 < n.length) || n[0] !== "o" && n[0] !== "O" || n[1] !== "n" && n[1] !== "N") n = hn.get(n) || n, qt(e, n, r);
			else return;
		}
		z = !0;
	}
	function op(e, t, n, r, a, o) {
		switch (n) {
			case "style":
				pn(e, r, o);
				return;
			case "dangerouslySetInnerHTML":
				if (r != null) {
					if (typeof r != "object" || !("__html" in r)) throw Error(i(61));
					if (n = r.__html, n != null) {
						if (a.children != null) throw Error(i(60));
						o?.__html !== n && (e.innerHTML = n);
					}
				}
				break;
			case "children":
				if (typeof r == "string") un(e, r);
				else if (typeof r == "number" || typeof r == "bigint") un(e, "" + r);
				else return;
				break;
			case "onScroll":
				r != null && J("scroll", e);
				return;
			case "onScrollEnd":
				r != null && J("scrollend", e);
				return;
			case "onClick":
				r != null && (e.onclick = vn);
				return;
			case "suppressContentEditableWarning":
			case "suppressHydrationWarning":
			case "innerHTML":
			case "ref": return;
			case "innerText":
			case "textContent": return;
			default:
				if (!zt.hasOwnProperty(n)) a: {
					if (n[0] === "o" && n[1] === "n" && (a = n.endsWith("Capture"), o = n.slice(2, a ? n.length - 7 : void 0), t = e[Ct] || null, t = t == null ? null : t[n], typeof t == "function" && e.removeEventListener(o, t, a), typeof r == "function")) {
						typeof t != "function" && t !== null && (n in e ? e[n] = null : e.hasAttribute(n) && e.removeAttribute(n)), e.addEventListener(o, r, a);
						break a;
					}
					z = !0, n in e ? e[n] = r : !0 === r ? e.setAttribute(n, "") : qt(e, n, r);
				}
				return;
		}
		z = !0;
	}
	function sp(e, t, n) {
		switch (t) {
			case "div":
			case "span":
			case "svg":
			case "path":
			case "a":
			case "g":
			case "p":
			case "li": break;
			case "img":
				J("error", e), J("load", e);
				var r = !1, a = !1, o;
				for (o in n) if (n.hasOwnProperty(o)) {
					var s = n[o];
					if (s != null) switch (o) {
						case "src":
							r = !0;
							break;
						case "srcSet":
							a = !0;
							break;
						case "children":
						case "dangerouslySetInnerHTML": throw Error(i(137, t));
						default: ap(e, t, o, s, n, null);
					}
				}
				a && ap(e, t, "srcSet", n.srcSet, n, null), r && ap(e, t, "src", n.src, n, null);
				return;
			case "input":
				J("invalid", e);
				var c = o = s = a = null, l = null, u = null;
				for (r in n) if (n.hasOwnProperty(r)) {
					var d = n[r];
					if (d != null) switch (r) {
						case "name":
							a = d;
							break;
						case "type":
							s = d;
							break;
						case "checked":
							l = d;
							break;
						case "defaultChecked":
							u = d;
							break;
						case "value":
							o = d;
							break;
						case "defaultValue":
							c = d;
							break;
						case "children":
						case "dangerouslySetInnerHTML":
							if (d != null) throw Error(i(137, t));
							break;
						default: ap(e, t, r, d, n, null);
					}
				}
				an(e, o, c, l, u, s, a, !1);
				return;
			case "select":
				for (a in J("invalid", e), r = s = o = null, n) if (n.hasOwnProperty(a) && (c = n[a], c != null)) switch (a) {
					case "value":
						o = c;
						break;
					case "defaultValue":
						s = c;
						break;
					case "multiple": r = c;
					default: ap(e, t, a, c, n, null);
				}
				t = o, n = s, e.multiple = !!r, t == null ? n != null && sn(e, !!r, n, !0) : sn(e, !!r, t, !1);
				return;
			case "textarea":
				for (s in J("invalid", e), o = a = r = null, n) if (n.hasOwnProperty(s) && (c = n[s], c != null)) switch (s) {
					case "value":
						r = c;
						break;
					case "defaultValue":
						a = c;
						break;
					case "children":
						o = c;
						break;
					case "dangerouslySetInnerHTML":
						if (c != null) throw Error(i(91));
						break;
					default: ap(e, t, s, c, n, null);
				}
				ln(e, r, a, o);
				return;
			case "option":
				for (l in n) if (n.hasOwnProperty(l) && (r = n[l], r != null)) switch (l) {
					case "selected":
						e.selected = r && typeof r != "function" && typeof r != "symbol";
						break;
					default: ap(e, t, l, r, n, null);
				}
				return;
			case "dialog":
				J("beforetoggle", e), J("toggle", e), J("cancel", e), J("close", e);
				break;
			case "iframe":
			case "object":
				J("load", e);
				break;
			case "video":
			case "audio":
				for (r = 0; r < Uf.length; r++) J(Uf[r], e);
				break;
			case "image":
				J("error", e), J("load", e);
				break;
			case "details":
				J("toggle", e);
				break;
			case "embed":
			case "source":
			case "link": J("error", e), J("load", e);
			case "area":
			case "base":
			case "br":
			case "col":
			case "hr":
			case "keygen":
			case "meta":
			case "param":
			case "track":
			case "wbr":
			case "menuitem":
				for (u in n) if (n.hasOwnProperty(u) && (r = n[u], r != null)) switch (u) {
					case "children":
					case "dangerouslySetInnerHTML": throw Error(i(137, t));
					default: ap(e, t, u, r, n, null);
				}
				return;
			default: if (mn(t)) {
				for (d in n) n.hasOwnProperty(d) && (r = n[d], r !== void 0 && op(e, t, d, r, n, void 0));
				return;
			}
		}
		for (c in n) n.hasOwnProperty(c) && (r = n[c], r != null && ap(e, t, c, r, n, null));
	}
	var cp = {};
	function lp(e, t, n, r) {
		switch (t) {
			case "div":
			case "span":
			case "svg":
			case "path":
			case "a":
			case "g":
			case "p":
			case "li": break;
			case "input":
				var a = null, o = null, s = null, c = null, l = null, u = null, d = null;
				for (m in n) {
					var f = n[m];
					if (n.hasOwnProperty(m) && f != null) switch (m) {
						case "checked": break;
						case "value": break;
						case "defaultValue": l = f;
						default: r.hasOwnProperty(m) || ap(e, t, m, null, r, f);
					}
				}
				for (var p in r) {
					var m = r[p];
					if (f = n[p], r.hasOwnProperty(p) && (m != null || f != null)) switch (p) {
						case "type":
							m !== f && (z = !0), o = m;
							break;
						case "name":
							m !== f && (z = !0), a = m;
							break;
						case "checked":
							m !== f && (z = !0), u = m;
							break;
						case "defaultChecked":
							m !== f && (z = !0), d = m;
							break;
						case "value":
							m !== f && (z = !0), s = m;
							break;
						case "defaultValue":
							m !== f && (z = !0), c = m;
							break;
						case "children":
						case "dangerouslySetInnerHTML":
							if (m != null) throw Error(i(137, t));
							break;
						default: m !== f && ap(e, t, p, m, r, f);
					}
				}
				rn(e, s, c, l, u, d, o, a);
				return;
			case "select":
				for (o in m = s = c = p = null, n) if (l = n[o], n.hasOwnProperty(o) && l != null) switch (o) {
					case "value": break;
					case "multiple": m = l;
					default: r.hasOwnProperty(o) || ap(e, t, o, null, r, l);
				}
				for (a in r) if (o = r[a], l = n[a], r.hasOwnProperty(a) && (o != null || l != null)) switch (a) {
					case "value":
						o !== l && (z = !0), p = o;
						break;
					case "defaultValue":
						o !== l && (z = !0), c = o;
						break;
					case "multiple": o !== l && (z = !0), s = o;
					default: o !== l && ap(e, t, a, o, r, l);
				}
				t = c, n = s, r = m, p == null ? !!r != !!n && (t == null ? sn(e, !!n, n ? [] : "", !1) : sn(e, !!n, t, !0)) : sn(e, !!n, p, !1);
				return;
			case "textarea":
				for (c in m = p = null, n) if (a = n[c], n.hasOwnProperty(c) && a != null && !r.hasOwnProperty(c)) switch (c) {
					case "value": break;
					case "children": break;
					default: ap(e, t, c, null, r, a);
				}
				for (s in r) if (a = r[s], o = n[s], r.hasOwnProperty(s) && (a != null || o != null)) switch (s) {
					case "value":
						a !== o && (z = !0), p = a;
						break;
					case "defaultValue":
						a !== o && (z = !0), m = a;
						break;
					case "children": break;
					case "dangerouslySetInnerHTML":
						if (a != null) throw Error(i(91));
						break;
					default: a !== o && ap(e, t, s, a, r, o);
				}
				cn(e, p, m);
				return;
			case "option":
				for (var h in n) if (p = n[h], n.hasOwnProperty(h) && p != null && !r.hasOwnProperty(h)) switch (h) {
					case "selected":
						e.selected = !1;
						break;
					default: ap(e, t, h, null, r, p);
				}
				for (l in r) if (p = r[l], m = n[l], r.hasOwnProperty(l) && p !== m && (p != null || m != null)) switch (l) {
					case "selected":
						p !== m && (z = !0), e.selected = p && typeof p != "function" && typeof p != "symbol";
						break;
					default: ap(e, t, l, p, r, m);
				}
				return;
			case "img":
			case "link":
			case "area":
			case "base":
			case "br":
			case "col":
			case "embed":
			case "hr":
			case "keygen":
			case "meta":
			case "param":
			case "source":
			case "track":
			case "wbr":
			case "menuitem":
				for (var g in n) p = n[g], n.hasOwnProperty(g) && p != null && !r.hasOwnProperty(g) && ap(e, t, g, null, r, p);
				for (u in r) if (p = r[u], m = n[u], r.hasOwnProperty(u) && p !== m && (p != null || m != null)) switch (u) {
					case "children":
					case "dangerouslySetInnerHTML":
						if (p != null) throw Error(i(137, t));
						break;
					default: ap(e, t, u, p, r, m);
				}
				return;
			default: if (mn(t)) {
				for (var _ in n) p = n[_], n.hasOwnProperty(_) && p !== void 0 && !r.hasOwnProperty(_) && op(e, t, _, void 0, r, p);
				for (d in r) p = r[d], m = n[d], !r.hasOwnProperty(d) || p === m || p === void 0 && m === void 0 || op(e, t, d, p, r, m);
				return;
			}
		}
		for (var v in n) p = n[v], n.hasOwnProperty(v) && p != null && !r.hasOwnProperty(v) && ap(e, t, v, null, r, p);
		for (f in r) p = r[f], m = n[f], !r.hasOwnProperty(f) || p === m || p == null && m == null || ap(e, t, f, p, r, m);
	}
	function up(e) {
		switch (e) {
			case "css":
			case "script":
			case "font":
			case "img":
			case "image":
			case "input":
			case "link": return !0;
			default: return !1;
		}
	}
	function dp() {
		if (typeof performance.getEntriesByType == "function") {
			for (var e = 0, t = 0, n = performance.getEntriesByType("resource"), r = 0; r < n.length; r++) {
				var i = n[r], a = i.transferSize, o = i.initiatorType, s = i.duration;
				if (a && s && up(o)) {
					for (o = 0, s = i.responseEnd, r += 1; r < n.length; r++) {
						var c = n[r], l = c.startTime;
						if (l > s) break;
						var u = c.transferSize, d = c.initiatorType;
						u && up(d) && (c = c.responseEnd, o += u * (c < s ? 1 : (s - l) / (c - l)));
					}
					if (--r, t += 8 * (a + o) / (i.duration / 1e3), e++, 10 < e) break;
				}
			}
			if (0 < e) return t / e / 1e6;
		}
		return navigator.connection && (e = navigator.connection.downlink, typeof e == "number") ? e : 5;
	}
	var fp = null, pp = null;
	function mp(e) {
		return e.nodeType === 9 ? e : e.ownerDocument;
	}
	function hp(e) {
		switch (e) {
			case "http://www.w3.org/2000/svg": return 1;
			case "http://www.w3.org/1998/Math/MathML": return 2;
			default: return 0;
		}
	}
	function gp(e, t) {
		if (e === 0) switch (t) {
			case "svg": return 1;
			case "math": return 2;
			default: return 0;
		}
		return e === 1 && t === "foreignObject" ? 0 : e;
	}
	function _p(e, t, n, r) {
		return n = mp(n).createElement(e), n[St] = r, n[Ct] = t, sp(n, e, t), It(n), n;
	}
	function vp(e, t) {
		return e === "textarea" || e === "noscript" || typeof t.children == "string" || typeof t.children == "number" || typeof t.children == "bigint" || typeof t.dangerouslySetInnerHTML == "object" && t.dangerouslySetInnerHTML !== null && t.dangerouslySetInnerHTML.__html != null;
	}
	var yp = null;
	function bp() {
		var e = window.event;
		return e && e.type === "popstate" ? e !== yp && (yp = e, !0) : (yp = null, !1);
	}
	var xp = typeof setTimeout == "function" ? setTimeout : void 0, Sp = typeof clearTimeout == "function" ? clearTimeout : void 0, Cp = typeof Promise == "function" ? Promise : void 0, wp = typeof requestAnimationFrame == "function" ? requestAnimationFrame : xp, Tp = typeof queueMicrotask == "function" ? queueMicrotask : Cp === void 0 ? xp : function(e) {
		return Cp.resolve(null).then(e).catch(Ep);
	};
	function Ep(e) {
		setTimeout(function() {
			throw e;
		});
	}
	function Dp(e) {
		return e === "head";
	}
	function Op(e, t) {
		var n = t, r = 0;
		do {
			var i = n.nextSibling;
			if (e.removeChild(n), i && i.nodeType === 8) {
				if (n = i.data, n === "/$" || n === "/&") {
					if (r === 0) {
						e.removeChild(i), Gh(t);
						return;
					}
					r--;
				} else if (n === "$" || n === "$?" || n === "$~" || n === "$!" || n === "&") r++;
				else if (n === "html") Sm(e.ownerDocument.documentElement);
				else if (n === "head") {
					n = e.ownerDocument.head, Sm(n);
					for (var a = n.firstChild; a;) {
						var o = a.nextSibling, s = a.nodeName;
						a[kt] || s === "SCRIPT" || s === "STYLE" || s === "LINK" && a.rel.toLowerCase() === "stylesheet" || n.removeChild(a), a = o;
					}
				} else n === "body" && Sm(e.ownerDocument.body);
			}
			n = i;
		} while (n);
		Gh(t);
	}
	function kp(e, t) {
		var n = e;
		e = 0;
		do {
			var r = n.nextSibling;
			if (n.nodeType === 1 ? t ? (n._stashedDisplay = n.style.display, n.style.display = "none") : (n.style.display = n._stashedDisplay || "", n.getAttribute("style") === "" && n.removeAttribute("style")) : n.nodeType === 3 && (t ? (n._stashedText = n.nodeValue, n.nodeValue = "") : n.nodeValue = n._stashedText || ""), r && r.nodeType === 8) {
				if (n = r.data, n === "/$") {
					if (e === 0) break;
					e--;
				} else n !== "$" && n !== "$?" && n !== "$~" && n !== "$!" || e++;
			}
			n = r;
		} while (n);
	}
	function Ap(e, t, n) {
		if (t = CSS.escape(t) === t ? t : "r-" + btoa(t).replace(/=/g, ""), e.style.viewTransitionName = t, n != null && (e.style.viewTransitionClass = n), n = getComputedStyle(e), n.display === "inline") {
			if (t = e.getClientRects(), t.length === 1) var r = 1;
			else for (var i = r = 0; i < t.length; i++) {
				var a = t[i];
				0 < a.width && 0 < a.height && r++;
			}
			r === 1 && (e = e.style, e.display = t.length === 1 ? "inline-block" : "block", e.marginTop = "-" + n.paddingTop, e.marginBottom = "-" + n.paddingBottom);
		}
	}
	function jp(e, t) {
		e = e.style, t = t.style;
		var n = t == null ? null : t.hasOwnProperty("viewTransitionName") ? t.viewTransitionName : t.hasOwnProperty("view-transition-name") ? t["view-transition-name"] : null;
		e.viewTransitionName = n == null || typeof n == "boolean" ? "" : ("" + n).trim(), n = t == null ? null : t.hasOwnProperty("viewTransitionClass") ? t.viewTransitionClass : t.hasOwnProperty("view-transition-class") ? t["view-transition-class"] : null, e.viewTransitionClass = n == null || typeof n == "boolean" ? "" : ("" + n).trim(), e.display === "inline-block" && (t == null ? e.display = e.margin = "" : (n = t.display, e.display = n == null || typeof n == "boolean" ? "" : n, n = t.margin, n == null ? (n = t.hasOwnProperty("marginTop") ? t.marginTop : t["margin-top"], e.marginTop = n == null || typeof n == "boolean" ? "" : n, t = t.hasOwnProperty("marginBottom") ? t.marginBottom : t["margin-bottom"], e.marginBottom = t == null || typeof t == "boolean" ? "" : t) : e.margin = n));
	}
	function Mp(e, t, n) {
		return n = n.ownerDocument.defaultView, {
			rect: e,
			abs: t.position === "absolute" || t.position === "fixed",
			clip: t.clipPath !== "none" || t.overflow !== "visible" || t.filter !== "none" || t.mask !== "none" || t.mask !== "none" || t.borderRadius !== "0px",
			view: 0 <= e.bottom && 0 <= e.right && e.top <= n.innerHeight && e.left <= n.innerWidth
		};
	}
	function Np(e) {
		return Mp(e.getBoundingClientRect(), getComputedStyle(e), e);
	}
	function Pp(e) {
		var t = e.getBoundingClientRect();
		t = new DOMRect(t.x + 2e4, t.y + 2e4, t.width, t.height);
		var n = getComputedStyle(e);
		return Mp(t, n, e);
	}
	function Fp(e) {
		return e.documentElement.clientHeight;
	}
	function Ip(e) {
		this.addEventListener("load", e), this.addEventListener("error", e);
	}
	function Lp(e, t, n, r, i, a, o, s, c) {
		var l = t.nodeType === 9 ? t : t.ownerDocument;
		try {
			var u = l.startViewTransition({
				update: function() {
					var t = l.defaultView, n = t.navigation && t.navigation.transition, o = l.fonts.status;
					r();
					var s = [];
					if (o === "loaded" && (Fp(l), l.fonts.status === "loading" && s.push(l.fonts.ready)), o = s.length, e !== null) for (var c = e.suspenseyImages, u = 0, d = 0; d < c.length; d++) {
						var f = c[d];
						if (!f.complete) {
							var p = f.getBoundingClientRect();
							if (0 < p.bottom && 0 < p.right && p.top < t.innerHeight && p.left < t.innerWidth) {
								if (u += $m(f), u > nh) {
									s.length = o;
									break;
								}
								f = new Promise(Ip.bind(f)), s.push(f);
							}
						}
					}
					if (0 < s.length) return t = Promise.race([Promise.all(s), new Promise(function(e) {
						return setTimeout(e, 500);
					})]).then(i, i), (n ? Promise.allSettled([n.finished, t]) : t).then(a, a);
					if (i(), n) return n.finished.then(a, a);
					a();
				},
				types: n
			});
			l.__reactViewTransition = u;
			var d = [];
			return u.ready.then(function() {
				for (var e = l.documentElement.getAnimations({ subtree: !0 }), t = 0; t < e.length; t++) {
					var n = e[t], r = n.effect, i = r.pseudoElement;
					if (i != null && i.startsWith("::view-transition")) {
						d.push(n), n = r.getKeyframes();
						for (var a = i = void 0, s = !0, c = 0; c < n.length; c++) {
							var u = n[c], f = u.width;
							if (i === void 0) i = f;
							else if (i !== f) {
								s = !1;
								break;
							}
							if (f = u.height, a === void 0) a = f;
							else if (a !== f) {
								s = !1;
								break;
							}
							delete u.width, delete u.height, u.transform === "none" && delete u.transform;
						}
						s && i !== void 0 && a !== void 0 && (r.setKeyframes(n), s = getComputedStyle(r.target, r.pseudoElement), s.width !== i || s.height !== a) && (s = n[0], s.width = i, s.height = a, s = n[n.length - 1], s.width = i, s.height = a, r.setKeyframes(n));
					}
				}
				o();
			}, function(e) {
				l.__reactViewTransition === u && (l.__reactViewTransition = null);
				try {
					if (typeof e == "object" && e) switch (e.name) {
						case "InvalidStateError": (e.message === "View transition was skipped because document visibility state is hidden." || e.message === "Skipping view transition because document visibility state has become hidden." || e.message === "Skipping view transition because viewport size changed." || e.message === "Transition was aborted because of invalid state") && (e = null);
					}
					e !== null && c(e);
				} finally {
					r(), i(), o();
				}
			}), u.finished.finally(function() {
				for (var e = 0; e < d.length; e++) d[e].cancel();
				l.__reactViewTransition === u && (l.__reactViewTransition = null), s();
			}), u;
		} catch {
			return r(), i(), o(), null;
		}
	}
	function Rp(e, t) {
		this._scope = document.documentElement, this._selector = "::view-transition-" + e + "(" + t + ")";
	}
	Rp.prototype.animate = function(e, t) {
		return t = typeof t == "number" ? { duration: t } : D({}, t), t.pseudoElement = this._selector, this._scope.animate(e, t);
	}, Rp.prototype.getAnimations = function() {
		for (var e = this._scope, t = this._selector, n = e.getAnimations({ subtree: !0 }), r = [], i = 0; i < n.length; i++) {
			var a = n[i].effect;
			a !== null && a.target === e && a.pseudoElement === t && r.push(n[i]);
		}
		return r;
	}, Rp.prototype.getComputedStyle = function() {
		return getComputedStyle(this._scope, this._selector);
	};
	function zp(e) {
		return {
			name: e,
			group: new Rp("group", e),
			imagePair: new Rp("image-pair", e),
			old: new Rp("old", e),
			new: new Rp("new", e)
		};
	}
	function Bp(e) {
		this._fragmentFiber = e, this._observers = this._eventListeners = null;
	}
	Bp.prototype.addEventListener = function(e, t, n) {
		var r = null, i = null;
		if (!(n != null && typeof n != "boolean" && (r = n.signal || null, r !== null && r.aborted))) {
			this._eventListeners === null && (this._eventListeners = []);
			var a = this._eventListeners;
			if (Gp(a, e, t, n) === -1) {
				var o = this, s = t;
				n != null && typeof n != "boolean" && !0 === n.once && (s = function(r) {
					o.removeEventListener(e, t, n), typeof t == "function" ? t.call(this, r) : t.handleEvent(r);
				}), r !== null && (i = o.removeEventListener.bind(o, e, t, n), r.addEventListener("abort", i, { once: !0 }), i = r.removeEventListener.bind(r, "abort", i)), r = Up(n), a.push({
					type: e,
					listener: t,
					optionsOrUseCapture: n,
					attachedListener: s,
					cleanup: i
				}), m(this._fragmentFiber.child, !1, Vp, e, s, r);
			}
			this._eventListeners = a;
		}
	};
	function Vp(e, t, n, r) {
		return b(e).addEventListener(t, n, r), !1;
	}
	Bp.prototype.removeEventListener = function(e, t, n) {
		var r = this._eventListeners;
		if (r !== null && (t = Gp(r, e, t, n), t !== -1)) {
			var i = r[t];
			n = i.attachedListener;
			var a = i.cleanup;
			i = Up(i.optionsOrUseCapture), m(this._fragmentFiber.child, !1, Hp, e, n, i), r.splice(t, 1), a !== null && a();
		}
	};
	function Hp(e, t, n, r) {
		return b(e).removeEventListener(t, n, r), !1;
	}
	function Up(e) {
		return e != null && typeof e != "boolean" && (!0 === e.once || e.signal instanceof AbortSignal) ? {
			capture: e.capture,
			passive: e.passive
		} : e;
	}
	function Wp(e) {
		return e == null ? "c=0" : typeof e == "boolean" ? "c=" + (e ? "1" : "0") : "c=" + (e.capture ? "1" : "0");
	}
	function Gp(e, t, n, r) {
		if (e.length === 0) return -1;
		r = Wp(r);
		for (var i = 0; i < e.length; i++) {
			var a = e[i];
			if (a.type === t && a.listener === n && Wp(a.optionsOrUseCapture) === r) return i;
		}
		return -1;
	}
	Bp.prototype.dispatchEvent = function(e) {
		var t = g(this._fragmentFiber);
		if (t === null) return !0;
		t = b(t);
		var n = this._eventListeners;
		if (n !== null && 0 < n.length || !e.bubbles) {
			var r = t.nodeType === 9 ? t.createComment("") : document.createTextNode("");
			if (n) for (var i = 0; i < n.length; i++) {
				var a = n[i];
				r.addEventListener(a.type, a.attachedListener, Up(a.optionsOrUseCapture));
			}
			if (t.appendChild(r), e = r.dispatchEvent(e), n) for (i = 0; i < n.length; i++) a = n[i], r.removeEventListener(a.type, a.attachedListener, Up(a.optionsOrUseCapture));
			return t.removeChild(r), e;
		}
		return t.dispatchEvent(e);
	}, Bp.prototype.focus = function(e) {
		m(this._fragmentFiber.child, !0, Kp, e, void 0, void 0);
	};
	function Kp(e, t) {
		return e.tag !== 6 && (e = b(e), vm(e, t));
	}
	Bp.prototype.focusLast = function(e) {
		var t = [];
		m(this._fragmentFiber.child, !0, qp, t, void 0, void 0);
		for (var n = t.length - 1; 0 <= n && !Kp(t[n], e); n--);
	};
	function qp(e, t) {
		return t.push(e), !1;
	}
	Bp.prototype.blur = function() {
		var e = g(this._fragmentFiber);
		e !== null && (e = b(e), e = mp(e).activeElement, e !== null && m(this._fragmentFiber.child, !1, Jp, e, void 0, void 0));
	};
	function Jp(e, t) {
		return e.tag !== 6 && (e = b(e), e === t || e.contains(t) ? (t.blur(), !0) : !1);
	}
	Bp.prototype.observeUsing = function(e) {
		this._observers === null && (this._observers = /* @__PURE__ */ new Set()), this._observers.add(e), m(this._fragmentFiber.child, !1, Yp, e, void 0, void 0);
	};
	function Yp(e, t) {
		return e.tag !== 6 && (e = b(e), t.observe(e), !1);
	}
	Bp.prototype.unobserveUsing = function(e) {
		var t = this._observers;
		if (t !== null && t.has(e)) {
			t.delete(e), m(this._fragmentFiber.child, !1, Xp, e, void 0, void 0);
			for (var n = t = 0; n < Zp.length; n++) {
				var r = Zp[n];
				r.fragmentInstance === this && r.observer === e ? e.unobserve(r.instance) : Zp[t++] = r;
			}
			Zp.length = t;
		}
	};
	function Xp(e, t) {
		return e.tag !== 6 && (e = b(e), t.unobserve(e), !1);
	}
	var Zp = [], Qp = !1;
	function $p(e, t, n) {
		Zp.push({
			fragmentInstance: e,
			observer: t,
			instance: n
		}), Qp || (Qp = !0, ym(function() {
			Qp = !1;
			var e = Zp;
			Zp = [];
			for (var t = 0; t < e.length; t++) {
				var n = e[t];
				n.observer.unobserve(n.instance);
			}
		}));
	}
	Bp.prototype.getClientRects = function() {
		var e = [];
		return m(this._fragmentFiber.child, !1, em, e, void 0, void 0), e;
	};
	function em(e, t) {
		if (e.tag === 6) {
			e = e.stateNode;
			var n = e.ownerDocument.createRange();
			n.selectNodeContents(e), t.push.apply(t, n.getClientRects());
		} else e = b(e), t.push.apply(t, e.getClientRects());
		return !1;
	}
	Bp.prototype.getRootNode = function(e) {
		var t = g(this._fragmentFiber);
		return t === null ? this : b(t).getRootNode(e);
	}, Bp.prototype.compareDocumentPosition = function(e) {
		var t = g(this._fragmentFiber);
		if (t === null) return Node.DOCUMENT_POSITION_DISCONNECTED;
		var n = [];
		m(this._fragmentFiber.child, !1, qp, n, void 0, void 0);
		var r = b(t);
		if (n.length === 0) {
			if (n = r, _(this._fragmentFiber)) {
				a: {
					for (t = this._fragmentFiber.return; t !== null;) {
						if (t.tag === 4) {
							t = t.stateNode.containerInfo;
							break a;
						}
						if (t.tag === 3 || t.tag === 5 || t.tag === 27) break;
						t = t.return;
					}
					t = null;
				}
				t != null && (n = t);
			}
			t = this._fragmentFiber;
			var i = r = n.compareDocumentPosition(e);
			return n === e ? i = Node.DOCUMENT_POSITION_CONTAINS : r & Node.DOCUMENT_POSITION_CONTAINED_BY && (n = v(t)[1], n === null ? i = Node.DOCUMENT_POSITION_PRECEDING : (e = b(n).compareDocumentPosition(e), i = e === 0 || e & Node.DOCUMENT_POSITION_FOLLOWING ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING)), i |= Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
		}
		t = b(n[0]), i = b(n[n.length - 1]);
		var a = _(this._fragmentFiber) ? t.parentElement : r;
		if (a == null) return Node.DOCUMENT_POSITION_DISCONNECTED;
		r = a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_CONTAINED_BY, a = a.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_CONTAINED_BY;
		var o = t.compareDocumentPosition(e), s = i.compareDocumentPosition(e), c = o & Node.DOCUMENT_POSITION_CONTAINED_BY || s & Node.DOCUMENT_POSITION_CONTAINED_BY;
		return s = r && a && o & Node.DOCUMENT_POSITION_FOLLOWING && s & Node.DOCUMENT_POSITION_PRECEDING, t = r && t === e || a && i === e || c || s ? Node.DOCUMENT_POSITION_CONTAINED_BY : !r && t === e || !a && i === e ? Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC : o, t & Node.DOCUMENT_POSITION_DISCONNECTED || t & Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC || tm(t, this._fragmentFiber, n[0], n[n.length - 1], e) ? t : Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;
	};
	function tm(e, t, n, r, i) {
		var a = Mt(i);
		if (e & Node.DOCUMENT_POSITION_CONTAINED_BY) {
			if (n = !!a) a: {
				for (; a !== null;) {
					if (a.tag === 7 && (a === t || a.alternate === t)) {
						n = !0;
						break a;
					}
					a = a.return;
				}
				n = !1;
			}
			return n;
		}
		if (e & Node.DOCUMENT_POSITION_CONTAINS) {
			if (a === null) return a = i.ownerDocument, i === a || i === a.documentElement || i === a.body;
			a: {
				for (a = t, t = g(t); a !== null;) {
					if (!(a.tag !== 5 && a.tag !== 3 && a.tag !== 27 || a !== t && a.alternate !== t)) {
						a = !0;
						break a;
					}
					a = a.return;
				}
				a = !1;
			}
			return a;
		}
		return e & Node.DOCUMENT_POSITION_PRECEDING ? ((t = !!a) && !(t = a === n) && (t = E(n, a, T), t === null ? t = !1 : (m(t, !0, C, a, n), a = x, x = null, t = a !== null)), t) : e & Node.DOCUMENT_POSITION_FOLLOWING ? ((t = !!a) && !(t = a === r) && (t = E(r, a, T), t === null ? t = !1 : (m(t, !0, w, a, r), a = x, S = x = null, t = a !== null)), t) : !1;
	}
	function nm(e, t) {
		var n = e.ownerDocument.createRange();
		n.selectNodeContents(e), e = n.getBoundingClientRect(), window.scrollTo(window.scrollX + e.left, t ? window.scrollY + e.top : window.scrollY + e.bottom - window.innerHeight);
	}
	Bp.prototype.scrollIntoView = function(e) {
		if (typeof e == "object") throw Error(i(566));
		var t = [];
		m(this._fragmentFiber.child, !1, qp, t, void 0, void 0);
		var n = !1 !== e;
		if (t.length === 0) {
			var r = v(this._fragmentFiber);
			if (r = n ? r[1] || r[0] || g(this._fragmentFiber) : r[0] || r[1], r === null) return;
			if (r.tag === 6) {
				e = b(r), nm(e, n);
				return;
			}
			if (r = b(r), r.nodeType !== 9) {
				if (r.nodeType === 11) {
					n = "host" in r ? r.host : null, n !== null && n.scrollIntoView(e);
					return;
				}
				r.scrollIntoView(e);
			}
		}
		for (r = n ? t.length - 1 : 0; r !== (n ? -1 : t.length);) {
			var a = t[r];
			a.tag === 6 ? (a = b(a), nm(a, n)) : b(a).scrollIntoView(e), r += n ? -1 : 1;
		}
	};
	function rm(e, t) {
		return e = b(e), im(e, t), !1;
	}
	function im(e, t) {
		e.reactFragments ??= /* @__PURE__ */ new Set(), e.reactFragments.add(t);
	}
	function am(e, t) {
		var n = t._eventListeners;
		if (n !== null) for (var r = 0; r < n.length; r++) {
			var i = n[r];
			e.addEventListener(i.type, i.attachedListener, Up(i.optionsOrUseCapture));
		}
		e.nodeType !== 3 && (n = t._observers, n !== null && n.forEach(function(n) {
			for (var r = 0, i = 0; i < Zp.length; i++) {
				var a = Zp[i];
				(a.fragmentInstance !== t || a.observer !== n || a.instance !== e) && (Zp[r++] = a);
			}
			Zp.length = r, n.observe(e);
		}), im(e, t));
	}
	function om(e, t) {
		var n = t._eventListeners;
		if (n !== null) for (var r = 0; r < n.length; r++) {
			var i = n[r];
			e.removeEventListener(i.type, i.attachedListener, Up(i.optionsOrUseCapture));
		}
		e.nodeType !== 3 && (n = t._observers, n !== null && n.forEach(function(n) {
			typeof n.rootMargin == "string" ? $p(t, n, e) : n.unobserve(e);
		}), e.reactFragments != null && e.reactFragments.delete(t));
	}
	function sm(e) {
		var t = e.firstChild;
		for (t && t.nodeType === 10 && (t = t.nextSibling); t;) {
			var n = t;
			switch (t = t.nextSibling, n.nodeName) {
				case "HTML":
				case "HEAD":
				case "BODY":
					sm(n), jt(n);
					continue;
				case "SCRIPT":
				case "STYLE": continue;
				case "LINK": if (n.rel.toLowerCase() === "stylesheet") continue;
			}
			e.removeChild(n);
		}
	}
	function cm(e, t, n, r) {
		for (; e.nodeType === 1;) {
			var i = n;
			if (e.nodeName.toLowerCase() !== t.toLowerCase()) {
				if (!r && (e.nodeName !== "INPUT" || e.type !== "hidden")) break;
			} else if (!r) {
				if (t === "input" && e.type === "hidden") {
					var a = i.name == null ? null : "" + i.name;
					if (i.type === "hidden" && e.getAttribute("name") === a) return e;
				} else return e;
			} else if (!e[kt]) switch (t) {
				case "meta":
					if (!e.hasAttribute("itemprop")) break;
					return e;
				case "link":
					if (a = e.getAttribute("rel"), a === "stylesheet" && e.hasAttribute("data-precedence") || a !== i.rel || e.getAttribute("href") !== (i.href == null || i.href === "" ? null : i.href) || e.getAttribute("crossorigin") !== (i.crossOrigin == null ? null : i.crossOrigin) || e.getAttribute("title") !== (i.title == null ? null : i.title)) break;
					return e;
				case "style":
					if (e.hasAttribute("data-precedence")) break;
					return e;
				case "script":
					if (a = e.getAttribute("src"), (a !== (i.src == null ? null : i.src) || e.getAttribute("type") !== (i.type == null ? null : i.type) || e.getAttribute("crossorigin") !== (i.crossOrigin == null ? null : i.crossOrigin)) && a && e.hasAttribute("async") && !e.hasAttribute("itemprop")) break;
					return e;
				default: return e;
			}
			if (e = mm(e.nextSibling), e === null) break;
		}
		return null;
	}
	function lm(e, t, n) {
		if (t === "") return null;
		for (; e.nodeType !== 3;) if ((e.nodeType !== 1 || e.nodeName !== "INPUT" || e.type !== "hidden") && !n || (e = mm(e.nextSibling), e === null)) return null;
		return e;
	}
	function um(e, t) {
		for (; e.nodeType !== 8;) if ((e.nodeType !== 1 || e.nodeName !== "INPUT" || e.type !== "hidden") && !t || (e = mm(e.nextSibling), e === null)) return null;
		return e;
	}
	function dm(e) {
		return e.data === "$?" || e.data === "$~";
	}
	function fm(e) {
		return e.data === "$!" || e.data === "$?" && e.ownerDocument.readyState !== "loading";
	}
	function pm(e, t) {
		var n = e.ownerDocument;
		if (e.data === "$~") e._reactRetry = t;
		else if (e.data !== "$?" || n.readyState !== "loading") t();
		else {
			var r = function() {
				t(), n.removeEventListener("DOMContentLoaded", r);
			};
			n.addEventListener("DOMContentLoaded", r), e._reactRetry = r;
		}
	}
	function mm(e) {
		for (; e != null; e = e.nextSibling) {
			var t = e.nodeType;
			if (t === 1 || t === 3) break;
			if (t === 8) {
				if (t = e.data, t === "$" || t === "$!" || t === "$?" || t === "$~" || t === "&" || t === "F!" || t === "F") break;
				if (t === "/$" || t === "/&") return null;
			}
		}
		return e;
	}
	var hm = null;
	function gm(e) {
		e = e.nextSibling;
		for (var t = 0; e;) {
			if (e.nodeType === 8) {
				var n = e.data;
				if (n === "/$" || n === "/&") {
					if (t === 0) return mm(e.nextSibling);
					t--;
				} else n !== "$" && n !== "$!" && n !== "$?" && n !== "$~" && n !== "&" || t++;
			}
			e = e.nextSibling;
		}
		return null;
	}
	function _m(e) {
		e = e.previousSibling;
		for (var t = 0; e;) {
			if (e.nodeType === 8) {
				var n = e.data;
				if (n === "$" || n === "$!" || n === "$?" || n === "$~" || n === "&") {
					if (t === 0) return e;
					t--;
				} else n !== "/$" && n !== "/&" || t++;
			}
			e = e.previousSibling;
		}
		return null;
	}
	function vm(e, t) {
		function n() {
			r = !0;
		}
		if (e.ownerDocument.activeElement === e) return !0;
		var r = !1;
		try {
			e.ownerDocument.addEventListener("focus", n, !0), (e.focus || HTMLElement.prototype.focus).call(e, t);
		} finally {
			e.ownerDocument.removeEventListener("focus", n, !0);
		}
		return r;
	}
	function ym(e) {
		wp(function() {
			wp(function(t) {
				return e(t);
			});
		});
	}
	function bm(e, t, n) {
		switch (t = mp(n), e) {
			case "html":
				if (e = t.documentElement, !e) throw Error(i(452));
				return e;
			case "head":
				if (e = t.head, !e) throw Error(i(453));
				return e;
			case "body":
				if (e = t.body, !e) throw Error(i(454));
				return e;
			default: throw Error(i(451));
		}
	}
	function xm(e, t, n) {
		for (var r in n) {
			var i = n[r];
			n.hasOwnProperty(r) && i != null && ap(e, t, r, null, cp, i);
		}
		n.dangerouslySetInnerHTML != null && (e.textContent = ""), e.onclick === vn && (e.onclick = null), jt(e);
	}
	function Sm(e) {
		for (var t = e.attributes; t.length;) e.removeAttributeNode(t[0]);
		jt(e);
	}
	var Cm = /* @__PURE__ */ new Map(), wm = /* @__PURE__ */ new Set();
	function Tm(e) {
		if (typeof e.getRootNode == "function") {
			var t = e.getRootNode();
			if (t.nodeType === 9 || t.nodeType === 11) return t;
		}
		return e.nodeType === 9 ? e : e.ownerDocument;
	}
	var Em = I.d;
	I.d = {
		f: Dm,
		r: Om,
		D: jm,
		C: Mm,
		L: Nm,
		m: Pm,
		X: Im,
		S: Fm,
		M: Y
	};
	function Dm() {
		var e = Em.f(), t = Hd();
		return e || t;
	}
	function Om(e) {
		var t = Nt(e);
		t !== null && t.tag === 5 && t.type === "form" ? nc(t) : Em.r(e);
	}
	var km = typeof document > "u" ? null : document;
	function Am(e, t, n) {
		var r = km;
		if (r && typeof t == "string" && t) {
			var i = nn(t);
			i = "link[rel=\"" + e + "\"][href=\"" + i + "\"]", typeof n == "string" && (i += "[crossorigin=\"" + n + "\"]"), wm.has(i) || (wm.add(i), e = {
				rel: e,
				crossOrigin: n,
				href: t
			}, r.querySelector(i) === null && (t = r.createElement("link"), sp(t, "link", e), It(t), r.head.appendChild(t)));
		}
	}
	function jm(e) {
		Em.D(e), Am("dns-prefetch", e, null);
	}
	function Mm(e, t) {
		Em.C(e, t), Am("preconnect", e, t);
	}
	function Nm(e, t, n) {
		Em.L(e, t, n);
		var r = km;
		if (r && e && t) {
			var i = "link[rel=\"preload\"][as=\"" + nn(t) + "\"]";
			t === "image" && n && n.imageSrcSet ? (i += "[imagesrcset=\"" + nn(n.imageSrcSet) + "\"]", typeof n.imageSizes == "string" && (i += "[imagesizes=\"" + nn(n.imageSizes) + "\"]")) : i += "[href=\"" + nn(e) + "\"]";
			var a = i;
			switch (t) {
				case "style":
					a = Rm(e);
					break;
				case "script": a = Vm(e);
			}
			if (!(Cm.has(a) || (e = D({
				rel: "preload",
				href: t === "image" && n && n.imageSrcSet ? void 0 : e,
				as: t
			}, n), Cm.set(a, e), r.querySelector(i) !== null || t === "style" && r.querySelector(X(a)) || t === "script" && r.querySelector(Hm(a))))) {
				var o = r.createElement("link");
				sp(o, "link", e), t === "style" && (o[At] = !0, o.onload = o.onerror = function() {
					Lt(o);
				}), It(o), r.head.appendChild(o);
			}
		}
	}
	function Pm(e, t) {
		Em.m(e, t);
		var n = km;
		if (n && e) {
			var r = t && typeof t.as == "string" ? t.as : "script", i = "link[rel=\"modulepreload\"][as=\"" + nn(r) + "\"][href=\"" + nn(e) + "\"]", a = i;
			switch (r) {
				case "audioworklet":
				case "paintworklet":
				case "serviceworker":
				case "sharedworker":
				case "worker":
				case "script": a = Vm(e);
			}
			if (!Cm.has(a) && (e = D({
				rel: "modulepreload",
				href: e
			}, t), Cm.set(a, e), n.querySelector(i) === null)) {
				switch (r) {
					case "audioworklet":
					case "paintworklet":
					case "serviceworker":
					case "sharedworker":
					case "worker":
					case "script": if (n.querySelector(Hm(a))) return;
				}
				r = n.createElement("link"), sp(r, "link", e), It(r), n.head.appendChild(r);
			}
		}
	}
	function Fm(e, t, n) {
		Em.S(e, t, n);
		var r = km;
		if (r && e) {
			var i = Ft(r).hoistableStyles, a = Rm(e);
			t ||= "default";
			var o = i.get(a);
			if (!o) {
				var s = {
					loading: 0,
					preload: null
				};
				if (o = r.querySelector(X(a))) s.loading = 5;
				else {
					e = D({
						rel: "stylesheet",
						href: e,
						"data-precedence": t
					}, n), (n = Cm.get(a)) && Gm(e, n);
					var c = o = r.createElement("link");
					It(c), sp(c, "link", e), c._p = new Promise(function(e, t) {
						c.onload = e, c.onerror = t;
					}), c.addEventListener("load", function() {
						s.loading |= 1;
					}), c.addEventListener("error", function() {
						s.loading |= 2;
					}), s.loading |= 4, Wm(o, t, r);
				}
				o = {
					type: "stylesheet",
					instance: o,
					count: 1,
					state: s
				}, i.set(a, o);
			}
		}
	}
	function Im(e, t) {
		Em.X(e, t);
		var n = km;
		if (n && e) {
			var r = Ft(n).hoistableScripts, i = Vm(e), a = r.get(i);
			a || (a = n.querySelector(Hm(i)), a || (e = D({
				src: e,
				async: !0
			}, t), (t = Cm.get(i)) && Km(e, t), a = n.createElement("script"), It(a), sp(a, "link", e), n.head.appendChild(a)), a = {
				type: "script",
				instance: a,
				count: 1,
				state: null
			}, r.set(i, a));
		}
	}
	function Y(e, t) {
		Em.M(e, t);
		var n = km;
		if (n && e) {
			var r = Ft(n).hoistableScripts, i = Vm(e), a = r.get(i);
			a || (a = n.querySelector(Hm(i)), a || (e = D({
				src: e,
				async: !0,
				type: "module"
			}, t), (t = Cm.get(i)) && Km(e, t), a = n.createElement("script"), It(a), sp(a, "link", e), n.head.appendChild(a)), a = {
				type: "script",
				instance: a,
				count: 1,
				state: null
			}, r.set(i, a));
		}
	}
	function Lm(e, t, n, r) {
		var a = (a = we.current) ? Tm(a) : null;
		if (!a) throw Error(i(446));
		switch (e) {
			case "meta":
			case "title": return null;
			case "style": return typeof n.precedence == "string" && typeof n.href == "string" ? (n = Rm(n.href), t = Ft(a).hoistableStyles, r = t.get(n), r || (r = {
				type: "style",
				instance: null,
				count: 0,
				state: null
			}, t.set(n, r)), r) : {
				type: "void",
				instance: null,
				count: 0,
				state: null
			};
			case "link":
				if (n.rel === "stylesheet" && typeof n.href == "string" && typeof n.precedence == "string") {
					e = Rm(n.href);
					var o = Ft(a).hoistableStyles, s = o.get(e);
					if (s || (a = a.ownerDocument || a, s = {
						type: "stylesheet",
						instance: null,
						count: 0,
						state: {
							loading: 0,
							preload: null
						}
					}, o.set(e, s), (o = a.querySelector(X(e))) ? o._p || (s.instance = o, s.state.loading = 5) : (o = Cm.get(e), o || (o = {
						rel: "preload",
						as: "style",
						href: n.href,
						crossOrigin: n.crossOrigin,
						integrity: n.integrity,
						media: n.media,
						hrefLang: n.hrefLang,
						referrerPolicy: n.referrerPolicy
					}, Cm.set(e, o)), Bm(a, e, o, s.state))), t && r === null) throw Error(i(528, ""));
					return s;
				}
				if (t && r !== null) throw Error(i(529, ""));
				return null;
			case "script": return t = n.async, n = n.src, typeof n == "string" && t && typeof t != "function" && typeof t != "symbol" ? (n = Vm(n), t = Ft(a).hoistableScripts, r = t.get(n), r || (r = {
				type: "script",
				instance: null,
				count: 0,
				state: null
			}, t.set(n, r)), r) : {
				type: "void",
				instance: null,
				count: 0,
				state: null
			};
			default: throw Error(i(444, e));
		}
	}
	function Rm(e) {
		return "href=\"" + nn(e) + "\"";
	}
	function X(e) {
		return "link[rel=\"stylesheet\"][" + e + "]";
	}
	function zm(e) {
		return D({}, e, {
			"data-precedence": e.precedence,
			precedence: null
		});
	}
	function Bm(e, t, n, r) {
		if (t = e.querySelector("link[rel=\"preload\"][as=\"style\"][" + t + "]")) {
			if (!0 !== t[At]) {
				r.loading = 1;
				return;
			}
		} else t = e.createElement("link"), t[At] = !0, t.onload = t.onerror = Lt.bind(null, t), sp(t, "link", n), It(t), e.head.appendChild(t);
		r.preload = t, t.addEventListener("load", function() {
			return r.loading |= 1;
		}), t.addEventListener("error", function() {
			return r.loading |= 2;
		});
	}
	function Vm(e) {
		return "[src=\"" + nn(e) + "\"]";
	}
	function Hm(e) {
		return "script[async]" + e;
	}
	function Um(e, t, n) {
		if (t.count++, t.instance === null) switch (t.type) {
			case "style":
				var r = e.querySelector("style[data-href~=\"" + nn(n.href) + "\"]");
				if (r) return t.instance = r, It(r), r;
				var a = D({}, n, {
					"data-href": n.href,
					"data-precedence": n.precedence,
					href: null,
					precedence: null
				});
				return r = (e.ownerDocument || e).createElement("style"), It(r), sp(r, "style", a), Wm(r, n.precedence, e), t.instance = r;
			case "stylesheet":
				a = Rm(n.href);
				var o = e.querySelector(X(a));
				if (o) return t.state.loading |= 4, t.instance = o, It(o), o;
				r = zm(n), (a = Cm.get(a)) && Gm(r, a), o = (e.ownerDocument || e).createElement("link"), It(o);
				var s = o;
				return s._p = new Promise(function(e, t) {
					s.onload = e, s.onerror = t;
				}), sp(o, "link", r), t.state.loading |= 4, Wm(o, n.precedence, e), t.instance = o;
			case "script": return o = Vm(n.src), (a = e.querySelector(Hm(o))) ? (t.instance = a, It(a), a) : (r = n, (a = Cm.get(o)) && (r = D({}, n), Km(r, a)), e = e.ownerDocument || e, a = e.createElement("script"), It(a), sp(a, "link", r), e.head.appendChild(a), t.instance = a);
			case "void": return null;
			default: throw Error(i(443, t.type));
		}
		else t.type === "stylesheet" && !(t.state.loading & 4) && (r = t.instance, t.state.loading |= 4, Wm(r, n.precedence, e));
		return t.instance;
	}
	function Wm(e, t, n) {
		for (var r = n.querySelectorAll("link[rel=\"stylesheet\"][data-precedence],style[data-precedence]"), i = r.length ? r[r.length - 1] : null, a = i, o = 0; o < r.length; o++) {
			var s = r[o];
			if (s.dataset.precedence === t) a = s;
			else if (a !== i) break;
		}
		a ? a.parentNode.insertBefore(e, a.nextSibling) : (t = n.nodeType === 9 ? n.head : n, t.insertBefore(e, t.firstChild));
	}
	function Gm(e, t) {
		e.crossOrigin ??= t.crossOrigin, e.referrerPolicy ??= t.referrerPolicy, e.title ??= t.title;
	}
	function Km(e, t) {
		e.crossOrigin ??= t.crossOrigin, e.referrerPolicy ??= t.referrerPolicy, e.integrity ??= t.integrity;
	}
	var qm = null;
	function Jm(e, t, n) {
		if (qm === null) {
			var r = /* @__PURE__ */ new Map(), i = qm = /* @__PURE__ */ new Map();
			i.set(n, r);
		} else i = qm, r = i.get(n), r || (r = /* @__PURE__ */ new Map(), i.set(n, r));
		if (r.has(e)) return r;
		for (r.set(e, null), n = n.getElementsByTagName(e), i = 0; i < n.length; i++) {
			var a = n[i];
			if (!(a[kt] || a[St] || e === "link" && a.getAttribute("rel") === "stylesheet") && a.namespaceURI !== "http://www.w3.org/2000/svg") {
				var o = a.getAttribute(t) || "";
				o = e + o;
				var s = r.get(o);
				s ? s.push(a) : r.set(o, [a]);
			}
		}
		return r;
	}
	function Ym(e, t, n) {
		e = e.ownerDocument || e, e.head.insertBefore(n, t === "title" ? e.querySelector("head > title") : null);
	}
	function Xm(e, t, n) {
		if (n === 1 || t.itemProp != null) return !1;
		switch (e) {
			case "meta":
			case "title": return !0;
			case "style":
				if (typeof t.precedence != "string" || typeof t.href != "string" || t.href === "") break;
				return !0;
			case "link":
				if (typeof t.rel != "string" || typeof t.href != "string" || t.href === "" || t.onLoad || t.onError) break;
				switch (t.rel) {
					case "stylesheet": return e = t.disabled, typeof t.precedence == "string" && e == null;
					default: return !0;
				}
			case "script": if (t.async && typeof t.async != "function" && typeof t.async != "symbol" && !t.onLoad && !t.onError && t.src && typeof t.src == "string") return !0;
		}
		return !1;
	}
	function Zm(e, t) {
		return e === "img" && t.src != null && t.src !== "" && t.onLoad == null && t.loading !== "lazy";
	}
	function Qm(e) {
		return !(e.type === "stylesheet" && !(e.state.loading & 3));
	}
	function $m(e) {
		return (e.width || 100) * (e.height || 100) * (typeof devicePixelRatio == "number" ? devicePixelRatio : 1) * .25;
	}
	function eh(e, t) {
		typeof t.decode == "function" && (e.imgCount++, t.complete || (e.imgBytes += $m(t), e.suspenseyImages.push(t)), e = oh.bind(e), t.decode().then(e, e));
	}
	function th(e, t, n, r) {
		if (n.type === "stylesheet" && (typeof r.media != "string" || !1 !== matchMedia(r.media).matches) && !(n.state.loading & 4)) {
			if (n.instance === null) {
				var i = Rm(r.href), a = t.querySelector(X(i));
				if (a) {
					t = a._p, typeof t == "object" && t && typeof t.then == "function" && (e.count++, e = ah.bind(e), t.then(e, e)), n.state.loading |= 4, n.instance = a, It(a);
					return;
				}
				a = t.ownerDocument || t, r = zm(r), (i = Cm.get(i)) && Gm(r, i), a = a.createElement("link"), It(a);
				var o = a;
				o._p = new Promise(function(e, t) {
					o.onload = e, o.onerror = t;
				}), sp(a, "link", r), n.instance = a;
			}
			e.stylesheets === null && (e.stylesheets = /* @__PURE__ */ new Map()), e.stylesheets.set(n, t), (t = n.state.preload) && !(n.state.loading & 3) && (e.count++, n = ah.bind(e), t.addEventListener("load", n), t.addEventListener("error", n));
		}
	}
	var nh = 0;
	function rh(e, t) {
		return e.stylesheets && e.count === 0 && ch(e, e.stylesheets), 0 < e.count || 0 < e.imgCount ? function(n) {
			var r = setTimeout(function() {
				if (e.stylesheets && ch(e, e.stylesheets), e.unsuspend) {
					var t = e.unsuspend;
					e.unsuspend = null, t();
				}
			}, 6e4 + t);
			0 < e.imgBytes && nh === 0 && (nh = 62500 * dp());
			var i = setTimeout(function() {
				if (e.waitingForImages = !1, e.count === 0 && (e.stylesheets && ch(e, e.stylesheets), e.unsuspend)) {
					var t = e.unsuspend;
					e.unsuspend = null, t();
				}
			}, (e.imgBytes > nh ? 50 : 800) + t);
			return e.unsuspend = n, function() {
				e.unsuspend = null, clearTimeout(r), clearTimeout(i);
			};
		} : null;
	}
	function ih(e) {
		if (e.count === 0 && (e.imgCount === 0 || !e.waitingForImages)) {
			if (e.stylesheets) ch(e, e.stylesheets);
			else if (e.unsuspend) {
				var t = e.unsuspend;
				e.unsuspend = null, t();
			}
		}
	}
	function ah() {
		this.count--, ih(this);
	}
	function oh() {
		this.imgCount--, ih(this);
	}
	var sh = null;
	function ch(e, t) {
		e.stylesheets = null, e.unsuspend !== null && (e.count++, sh = /* @__PURE__ */ new Map(), t.forEach(lh, e), sh = null, ah.call(e));
	}
	function lh(e, t) {
		if (!(t.state.loading & 4)) {
			var n = sh.get(e);
			if (n) var r = n.get(null);
			else {
				n = /* @__PURE__ */ new Map(), sh.set(e, n);
				for (var i = e.querySelectorAll("link[data-precedence],style[data-precedence]"), a = 0; a < i.length; a++) {
					var o = i[a];
					(o.nodeName === "LINK" || o.getAttribute("media") !== "not all") && (n.set(o.dataset.precedence, o), r = o);
				}
				r && n.set(null, r);
			}
			i = t.instance, o = i.getAttribute("data-precedence"), a = n.get(o) || r, a === r && n.set(null, i), n.set(o, i), this.count++, r = ah.bind(this), i.addEventListener("load", r), i.addEventListener("error", r), a ? a.parentNode.insertBefore(i, a.nextSibling) : (e = e.nodeType === 9 ? e.head : e, e.insertBefore(i, e.firstChild)), t.state.loading |= 4;
		}
	}
	var uh = {
		$$typeof: M,
		Provider: null,
		Consumer: null,
		_currentValue: ge,
		_currentValue2: ge,
		_threadCount: 0
	};
	function dh(e, t, n, r, i, a, o, s, c) {
		this.tag = 1, this.containerInfo = e, this.pingCache = this.current = this.pendingChildren = null, this.timeoutHandle = -1, this.callbackNode = this.next = this.pendingContext = this.context = this.cancelPendingCommit = null, this.callbackPriority = 0, this.expirationTimes = dt(-1), this.entangledLanes = this.shellSuspendCounter = this.errorRecoveryDisabledLanes = this.expiredLanes = this.warmLanes = this.pingedLanes = this.suspendedLanes = this.pendingLanes = 0, this.entanglements = dt(0), this.hiddenUpdates = dt(null), this.identifierPrefix = r, this.onUncaughtError = i, this.onCaughtError = a, this.onRecoverableError = o, this.pooledCache = null, this.pooledCacheLanes = 0, this.formState = c, this.transitionTypes = null, this.incompleteTransitions = /* @__PURE__ */ new Map();
	}
	function fh(e, t, n, r, i, a, o, s, c, l, u, d) {
		return e = new dh(e, t, n, o, c, l, u, d, s), t = 1, !0 === a && (t |= 24), a = ji(3, null, null, t), e.current = a, a.stateNode = e, t = Aa(), t.refCount++, e.pooledCache = t, t.refCount++, a.memoizedState = {
			element: r,
			isDehydrated: n,
			cache: t
		}, po(a), e;
	}
	function ph(e) {
		return e ? (e = ki, e) : ki;
	}
	function mh(e, t, n, r, i, a) {
		i = ph(i), r.context === null ? r.context = i : r.pendingContext = i, r = ho(t), r.payload = { element: n }, a = a === void 0 ? null : a, a !== null && (r.callback = a), n = go(e, r, t), n !== null && (Ld(n, e, t), _o(n, e, t));
	}
	function hh(e, t) {
		if (e = e.memoizedState, e !== null && e.dehydrated !== null) {
			var n = e.retryLane;
			e.retryLane = n !== 0 && n < t ? n : t;
		}
	}
	function gh(e, t) {
		hh(e, t), (e = e.alternate) && hh(e, t);
	}
	function _h(e) {
		if (e.tag === 13 || e.tag === 31) {
			var t = Ei(e, 67108864);
			t !== null && Ld(t, e, 67108864), gh(e, 67108864);
		}
	}
	function vh(e) {
		if (e.tag === 13 || e.tag === 31) {
			var t = Pd();
			t = _t(t);
			var n = Ei(e, t);
			n !== null && Ld(n, e, t), gh(e, t);
		}
	}
	var yh = !0;
	function bh(e, t, n, r) {
		var i = F.T;
		F.T = null;
		var a = I.p;
		try {
			I.p = 2, Sh(e, t, n, r);
		} finally {
			I.p = a, F.T = i;
		}
	}
	function xh(e, t, n, r) {
		var i = F.T;
		F.T = null;
		var a = I.p;
		try {
			I.p = 8, Sh(e, t, n, r);
		} finally {
			I.p = a, F.T = i;
		}
	}
	function Sh(e, t, n, r) {
		if (yh) {
			var i = Ch(r);
			if (i === null) Xf(e, t, r, wh, n), Fh(e, r);
			else if (Lh(i, e, t, n, r)) r.stopPropagation();
			else if (Fh(e, r), t & 4 && -1 < Ph.indexOf(e)) {
				for (; i !== null;) {
					var a = Nt(i);
					if (a !== null) switch (a.tag) {
						case 3:
							if (a = a.stateNode, a.current.memoizedState.isDehydrated) {
								var o = at(a.pendingLanes);
								if (o !== 0) {
									var s = a;
									for (s.pendingLanes |= 2, s.entangledLanes |= 2; o;) {
										var c = 1 << 31 - $e(o);
										s.entanglements[1] |= c, o &= ~c;
									}
									Af(a), !(G & 6) && (yd = He() + 500, jf(0, !1));
								}
							}
							break;
						case 31:
						case 13: s = Ei(a, 2), s !== null && Ld(s, a, 2), Hd(), gh(a, 2);
					}
					if (a = Ch(r), a === null && Xf(e, t, r, wh, n), a === i) break;
					i = a;
				}
				i !== null && r.stopPropagation();
			} else Xf(e, t, r, null, n);
		}
	}
	function Ch(e) {
		return e = bn(e), Th(e);
	}
	var wh = null;
	function Th(e) {
		if (wh = null, e = Mt(e), e !== null) {
			var t = o(e);
			if (t === null) e = null;
			else {
				var n = t.tag;
				if (n === 13) {
					if (e = s(t), e !== null) return e;
					e = null;
				} else if (n === 31) {
					if (e = c(t), e !== null) return e;
					e = null;
				} else if (n === 3) {
					if (t.stateNode.current.memoizedState.isDehydrated) return t.tag === 3 ? t.stateNode.containerInfo : null;
					e = null;
				} else t !== e && (e = null);
			}
		}
		return wh = e, null;
	}
	function Eh(e) {
		switch (e) {
			case "beforetoggle":
			case "cancel":
			case "click":
			case "close":
			case "contextmenu":
			case "copy":
			case "cut":
			case "auxclick":
			case "dblclick":
			case "dragend":
			case "dragstart":
			case "drop":
			case "focusin":
			case "focusout":
			case "input":
			case "invalid":
			case "keydown":
			case "keypress":
			case "keyup":
			case "mousedown":
			case "mouseup":
			case "paste":
			case "pause":
			case "play":
			case "pointercancel":
			case "pointerdown":
			case "pointerup":
			case "ratechange":
			case "reset":
			case "seeked":
			case "submit":
			case "toggle":
			case "touchcancel":
			case "touchend":
			case "touchstart":
			case "volumechange":
			case "change":
			case "selectionchange":
			case "textInput":
			case "compositionstart":
			case "compositionend":
			case "compositionupdate":
			case "beforeblur":
			case "afterblur":
			case "beforeinput":
			case "blur":
			case "fullscreenchange":
			case "fullscreenerror":
			case "focus":
			case "hashchange":
			case "popstate":
			case "select":
			case "selectstart": return 2;
			case "drag":
			case "dragenter":
			case "dragexit":
			case "dragleave":
			case "dragover":
			case "mousemove":
			case "mouseout":
			case "mouseover":
			case "pointermove":
			case "pointerout":
			case "pointerover":
			case "resize":
			case "scroll":
			case "touchmove":
			case "wheel":
			case "mouseenter":
			case "mouseleave":
			case "pointerenter":
			case "pointerleave": return 8;
			case "message": switch (Ue()) {
				case We: return 2;
				case Ge: return 8;
				case Ke:
				case qe: return 32;
				case Je: return 268435456;
				default: return 32;
			}
			default: return 32;
		}
	}
	var Dh = !1, Oh = null, kh = null, Ah = null, jh = /* @__PURE__ */ new Map(), Mh = /* @__PURE__ */ new Map(), Nh = [], Ph = "mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(" ");
	function Fh(e, t) {
		switch (e) {
			case "focusin":
			case "focusout":
				Oh = null;
				break;
			case "dragenter":
			case "dragleave":
				kh = null;
				break;
			case "mouseover":
			case "mouseout":
				Ah = null;
				break;
			case "pointerover":
			case "pointerout":
				jh.delete(t.pointerId);
				break;
			case "gotpointercapture":
			case "lostpointercapture": Mh.delete(t.pointerId);
		}
	}
	function Ih(e, t, n, r, i, a) {
		return e === null || e.nativeEvent !== a ? (e = {
			blockedOn: t,
			domEventName: n,
			eventSystemFlags: r,
			nativeEvent: a,
			targetContainers: [i]
		}, t !== null && (t = Nt(t), t !== null && _h(t)), e) : (e.eventSystemFlags |= r, t = e.targetContainers, i !== null && t.indexOf(i) === -1 && t.push(i), e);
	}
	function Lh(e, t, n, r, i) {
		switch (t) {
			case "focusin": return Oh = Ih(Oh, e, t, n, r, i), !0;
			case "dragenter": return kh = Ih(kh, e, t, n, r, i), !0;
			case "mouseover": return Ah = Ih(Ah, e, t, n, r, i), !0;
			case "pointerover":
				var a = i.pointerId;
				return jh.set(a, Ih(jh.get(a) || null, e, t, n, r, i)), !0;
			case "gotpointercapture": return a = i.pointerId, Mh.set(a, Ih(Mh.get(a) || null, e, t, n, r, i)), !0;
		}
		return !1;
	}
	function Rh(e) {
		var t = Mt(e.target);
		if (t !== null) {
			var n = o(t);
			if (n !== null) {
				if (t = n.tag, t === 13) {
					if (t = s(n), t !== null) {
						e.blockedOn = t, bt(e.priority, function() {
							vh(n);
						});
						return;
					}
				} else if (t === 31) {
					if (t = c(n), t !== null) {
						e.blockedOn = t, bt(e.priority, function() {
							vh(n);
						});
						return;
					}
				} else if (t === 3 && n.stateNode.current.memoizedState.isDehydrated) {
					e.blockedOn = n.tag === 3 ? n.stateNode.containerInfo : null;
					return;
				}
			}
		}
		e.blockedOn = null;
	}
	function zh(e) {
		if (e.blockedOn !== null) return !1;
		for (var t = e.targetContainers; 0 < t.length;) {
			var n = Ch(e.nativeEvent);
			if (n === null) {
				n = e.nativeEvent;
				var r = new n.constructor(n.type, n);
				yn = r, n.target.dispatchEvent(r), yn = null;
			} else return t = Nt(n), t !== null && _h(t), e.blockedOn = n, !1;
			t.shift();
		}
		return !0;
	}
	function Bh(e, t, n) {
		zh(e) && n.delete(t);
	}
	function Vh() {
		Dh = !1, Oh !== null && zh(Oh) && (Oh = null), kh !== null && zh(kh) && (kh = null), Ah !== null && zh(Ah) && (Ah = null), jh.forEach(Bh), Mh.forEach(Bh);
	}
	function Hh(e, n) {
		e.blockedOn === n && (e.blockedOn = null, Dh || (Dh = !0, t.unstable_scheduleCallback(t.unstable_NormalPriority, Vh)));
	}
	var Uh = null;
	function Wh(e) {
		Uh !== e && (Uh = e, t.unstable_scheduleCallback(t.unstable_NormalPriority, function() {
			Uh === e && (Uh = null);
			for (var t = 0; t < e.length; t += 3) {
				var n = e[t], r = e[t + 1], i = e[t + 2];
				if (typeof r != "function") {
					if (Th(r || n) === null) continue;
					break;
				}
				var a = Nt(n);
				a !== null && (e.splice(t, 3), t -= 3, ec(a, {
					pending: !0,
					data: i,
					method: n.method,
					action: r
				}, r, i));
			}
		}));
	}
	function Gh(e) {
		function t(t) {
			return Hh(t, e);
		}
		Oh !== null && Hh(Oh, e), kh !== null && Hh(kh, e), Ah !== null && Hh(Ah, e), jh.forEach(t), Mh.forEach(t);
		for (var n = 0; n < Nh.length; n++) {
			var r = Nh[n];
			r.blockedOn === e && (r.blockedOn = null);
		}
		for (; 0 < Nh.length && (n = Nh[0], n.blockedOn === null);) Rh(n), n.blockedOn === null && Nh.shift();
		if (n = (e.ownerDocument || e).$$reactFormReplay, n != null) for (r = 0; r < n.length; r += 3) {
			var i = n[r], a = n[r + 1], o = i[Ct] || null;
			if (typeof a == "function") o || Wh(n);
			else if (o) {
				var s = null;
				if (a && a.hasAttribute("formAction")) {
					if (i = a, o = a[Ct] || null) s = o.formAction;
					else if (Th(i) !== null) continue;
				} else s = o.action;
				typeof s == "function" ? n[r + 1] = s : (n.splice(r, 3), r -= 3), Wh(n);
			}
		}
	}
	function Kh() {
		function e(e) {
			e.canIntercept && e.info === "react-transition" && e.intercept({
				handler: function() {
					return new Promise(function(e) {
						return i = e;
					});
				},
				focusReset: "manual",
				scroll: "manual"
			});
		}
		function t() {
			i !== null && (i(), i = null), r || setTimeout(n, 20);
		}
		function n() {
			if (!r && !navigation.transition) {
				var e = navigation.currentEntry;
				e && e.url != null && navigation.navigate(e.url, {
					state: e.getState(),
					info: "react-transition",
					history: "replace"
				});
			}
		}
		if (typeof navigation == "object") {
			var r = !1, i = null;
			return navigation.addEventListener("navigate", e), navigation.addEventListener("navigatesuccess", t), navigation.addEventListener("navigateerror", t), setTimeout(n, 100), function() {
				r = !0, navigation.removeEventListener("navigate", e), navigation.removeEventListener("navigatesuccess", t), navigation.removeEventListener("navigateerror", t), i !== null && (i(), i = null);
			};
		}
	}
	function qh(e) {
		this._internalRoot = e;
	}
	Jh.prototype.render = qh.prototype.render = function(e) {
		var t = this._internalRoot;
		if (t === null) throw Error(i(409));
		var n = t.current;
		mh(n, Pd(), e, t, null, null);
	}, Jh.prototype.unmount = qh.prototype.unmount = function() {
		var e = this._internalRoot;
		if (e !== null) {
			this._internalRoot = null;
			var t = e.containerInfo;
			mh(e.current, 2, null, e, null, null), Hd(), t[wt] = null;
		}
	};
	function Jh(e) {
		this._internalRoot = e;
	}
	Jh.prototype.unstable_scheduleHydration = function(e) {
		if (e) {
			var t = yt();
			e = {
				blockedOn: null,
				target: e,
				priority: t
			};
			for (var n = 0; n < Nh.length && t !== 0 && t < Nh[n].priority; n++);
			Nh.splice(n, 0, e), n === 0 && Rh(e);
		}
	};
	var Yh = n.version;
	if (Yh !== "19.3.0") throw Error(i(527, Yh, "19.3.0"));
	I.findDOMNode = function(e) {
		var t = e._reactInternals;
		if (t === void 0) throw typeof e.render == "function" ? Error(i(188)) : (e = Object.keys(e).join(","), Error(i(268, e)));
		return e = u(t), e = e === null ? null : f(e), e = e === null ? null : e.stateNode, e;
	};
	var Xh = {
		bundleType: 0,
		version: "19.3.0",
		rendererPackageName: "react-dom",
		currentDispatcherRef: F,
		reconcilerVersion: "19.3.0"
	};
	if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u") {
		var Zh = __REACT_DEVTOOLS_GLOBAL_HOOK__;
		if (!Zh.isDisabled && Zh.supportsFiber) try {
			Ze = Zh.inject(Xh), L = Zh;
		} catch {}
	}
	e.createRoot = function(e, t) {
		if (!a(e)) throw Error(i(299));
		var n = !1, r = "", o = Cc, s = wc, c = Tc;
		return t != null && (!0 === t.unstable_strictMode && (n = !0), t.identifierPrefix !== void 0 && (r = t.identifierPrefix), t.onUncaughtError !== void 0 && (o = t.onUncaughtError), t.onCaughtError !== void 0 && (s = t.onCaughtError), t.onRecoverableError !== void 0 && (c = t.onRecoverableError)), t = fh(e, 1, !1, null, null, n, r, null, o, s, c, Kh), e[wt] = t.current, Jf(e), new qh(t);
	};
})), _ = /* @__PURE__ */ o(((e, t) => {
	function n() {
		if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE == "function") try {
			__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n);
		} catch (e) {
			console.error(e);
		}
	}
	n(), t.exports = g();
})), v = null;
function y(e, t) {
	e.currentIndex = 0, e.wipContextDeps = null, e.wipCommitCallbacks = [];
	let n = v;
	v = e;
	try {
		if (t(), e.isFirstRender = !1, e.cells.length !== e.currentIndex) throw Error(`Rendered ${e.currentIndex} hooks but expected ${e.cells.length}. Hooks must be called in the exact same order in every render.`);
	} finally {
		v = n;
	}
}
function b() {
	if (!v) throw Error("No resource fiber available");
	return v;
}
function x() {
	return v;
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/helpers/env.js
var S = typeof process < "u" && !1, C = (e) => ({
	version: 0,
	committedVersion: 0,
	dispatchUpdate: e,
	changelog: [],
	committedLog: [],
	unsettledCount: 0,
	rollbackCallbacks: []
}), w = (e) => {
	e.committedVersion = e.version;
	for (let t of e.changelog) t.logged = !1, t.settled || (t.settled = !0, e.unsettledCount--), e.committedLog.push(t);
	e.changelog.length = 0, e.unsettledCount === 0 && (e.committedLog.length = 0), e.rollbackCallbacks.length = 0;
}, T = (e, t) => {
	let n = e.version > t;
	if (e.version = t, n) {
		for (let t = 0; t < e.rollbackCallbacks.length; t++) e.rollbackCallbacks[t]();
		if (e.rollbackCallbacks.length = 0, t <= e.committedVersion) {
			let n = [];
			for (; e.committedVersion - n.length > t;) {
				let t = e.committedLog.pop();
				if (t === void 0) {
					if (S) throw Error("tap: committed history is shorter than the replay base.");
					break;
				}
				k(t.fiber, t.cell), t.cell.workInProgress = t.prevState, n.push({
					record: t,
					prevState: t.prevState,
					eagerState: t.eagerState,
					hasEagerState: t.hasEagerState
				});
			}
			if (n.length > 0) {
				let t = e.committedVersion;
				O(e, () => {
					for (let t = n.length - 1; t >= 0; t--) {
						let r = n[t];
						r.record.prevState = r.prevState, r.record.eagerState = r.eagerState, r.record.hasEagerState = r.hasEagerState, e.committedLog.push(r.record);
					}
					e.committedVersion = t;
				});
			}
			e.committedVersion = t;
			for (let t of e.changelog) t.logged = !1;
			e.changelog.length = 0;
		} else {
			for (; e.committedVersion + e.changelog.length > t;) e.changelog.pop().logged = !1;
			for (let t = 0; t < e.changelog.length; t++) E(e.changelog[t]);
			w(e);
		}
	}
}, E = (e) => {
	k(e.fiber, e.cell), e.queued || (e.queued = !0, (e.cell.queue ??= []).push(e));
}, D = (e, t) => {
	e.wipCommitCallbacks.push(t);
}, O = (e, t) => {
	e.rollbackCallbacks.push(t);
}, k = (e, t) => {
	t.isDirty || (t.isDirty = !0, e.markDirty?.(), O(e.root, () => {
		if (t.queue !== null) {
			for (let e of t.queue) e.queued = !1;
			t.queue = null;
		}
		t.workInProgress = t.current, t.isDirty = !1;
	}));
}, ee = Symbol.for("react.memo_cache_sentinel"), A = (e) => Array(e).fill(ee), te = (e, t) => {
	let n = e.memoCache, r = n.workInProgress;
	if (r === null) {
		let t = n.current;
		r = t === null ? [] : t.map((e) => e.slice()), n.workInProgress = r, O(e.root, () => {
			n.workInProgress = null;
		});
	}
	let i = n.index++, a = r[i];
	return a === void 0 ? (a = A(t), r[i] = a) : S && a.length !== t && console.error(`Expected a constant size argument for each invocation of c(). The previous cache was allocated with size ${a.length} but size ${t} was requested.`), a;
}, ne = (e) => te(b(), e), j = /* @__PURE__ */ l(d(), 1), M = j.default.__COMPILER_RUNTIME?.c ?? ((e) => (0, j.useMemo)(() => {
	let t = A(e);
	return t[ee] = !0, t;
}, [])), re = () => x() !== null, N = (e) => re() ? ne(e) : M(e), P = (e, ...t) => Object.assign(Object.create(null), e, ...t), ie = () => {
	throw Error("Rendered more hooks than during the previous render. Hooks must be called in the exact same order in every render.");
}, ae = () => {
	throw Error("Hook order changed between renders");
}, oe = () => ({
	type: "effect",
	setup: void 0,
	setupDeps: void 0,
	cleanup: void 0,
	deps: null,
	generation: 0
});
function se(e, t) {
	let n = b(), r = n.currentIndex++, i = n.cells[r], a = i === void 0 ? oe() : i.type === "effect" ? i : ae();
	if (i === void 0 && (n.isFirstRender || ie(), n.cells[r] = a, n.effectCells.push(a)), a.deps !== null && !!t != !!a.deps) throw Error("useEffect called with and without dependencies across re-renders");
	D(n, () => {
		a.setup = e, a.setupDeps = t, a.generation++;
	});
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/hooks/utils/depsShallowEqual.js
var ce = (e, t) => {
	S && e.length !== t.length && console.error(`The final argument passed to a hook changed size between renders. The order and size of this array must remain constant.

Previous: [${e.join(", ")}]\nIncoming: [${t.join(", ")}]`);
	for (let n = 0; n < e.length && n < t.length; n++) if (!Object.is(e[n], t[n])) return !1;
	return !0;
}, le = (e, t) => {
	D(e, () => {
		t.current = t.wip, t.currentDeps = t.wipDeps, t.isDirty = !1;
	});
}, ue = (e, t) => {
	let n = b(), r = n.currentIndex++, i = n.cells[r];
	if (i === void 0) {
		n.isFirstRender || ie();
		let a = e();
		return S && n.devStrictMode && e(), i = {
			type: "memo",
			current: a,
			currentDeps: t,
			wip: a,
			wipDeps: t,
			isDirty: !1
		}, n.cells[r] = i, a;
	}
	i.type !== "memo" && ae();
	let a = i;
	if (ce(a.wipDeps, t)) return a.isDirty && le(n, a), a.wip;
	let o = e();
	return S && n.devStrictMode && e(), a.wip = o, a.wipDeps = t, a.isDirty || (a.isDirty = !0, O(n.root, () => {
		a.wip = a.current, a.wipDeps = a.currentDeps, a.isDirty = !1;
	})), le(n, a), o;
};
//#endregion
//#region node_modules/@assistant-ui/tap/dist/react-hooks/useRef.js
function de(e) {
	return ue(() => ({ current: e }), []);
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/context.js
var fe = Symbol("tap.Context.defaultValue"), pe = (e) => e, me = /* @__PURE__ */ new Map(), he = /* @__PURE__ */ new Set(), F = () => new Map(me), I = (e, t) => {
	let n = me;
	me = e;
	try {
		return t();
	} finally {
		me = n;
	}
}, ge = (e, t) => {
	e[fe] = t;
}, _e = (e) => typeof e == "object" && !!e && fe in e, ve = (e) => typeof e == "object" && !!e && "$$typeof" in e && e.$$typeof === Symbol.for("react.context"), ye = (e) => _e(e) || ve(e), be = (e) => {
	if (!_e(e)) {
		if (ve(e)) {
			ge(e, e._currentValue ?? e._currentValue2);
			return;
		}
		throw Error("A tap resource's `use()` only accepts a tap context.");
	}
}, xe = (e, t, n) => {
	if (typeof e != "object" || !e) throw Error("useContextProvider only accepts a React context.");
	be(e);
	let r = e, i = b(), a = de(void 0), o = a.current === void 0 || !Object.is(a.current.value, t);
	se(() => {
		a.current = { value: t };
	}, [t]);
	let s = me.get(r), c = s !== void 0 || me.has(r);
	me.set(r, {
		value: t,
		source: i
	});
	try {
		return Se(r, o, n);
	} finally {
		c ? me.set(r, s) : me.delete(r);
	}
}, Se = (e, t, n) => {
	let r = he.has(e);
	t ? he.add(e) : he.delete(e);
	try {
		return n();
	} finally {
		r ? he.add(e) : he.delete(e);
	}
}, Ce = (e) => {
	be(e);
	let t = e, n = we(t, e), r = b();
	return (r.wipContextDeps ??= /* @__PURE__ */ new Map()).set(t, n.source), n.value;
}, we = (e, t) => me.get(e) ?? {
	value: pe(t)[fe],
	source: null
}, Te = (e, t, n, r) => {
	if (!r) return n;
	let i = n;
	for (let [n, a] of r) a !== t && a !== e && (i ??= /* @__PURE__ */ new Map()).set(n, a);
	return i;
}, Ee = (e, t = e.wipContextDeps) => {
	let n = x();
	n && t && (n.wipContextDeps = Te(n, e, n.wipContextDeps, t));
}, De = () => he.size > 0, Oe = (e) => {
	if (!e.contextDeps || !De()) return !1;
	for (let t of he.keys()) if (e.contextDeps.has(t)) return !0;
	return !1;
}, ke = (e, t, n) => {
	if (e.isNeverMounted) throw Error("Resource updated before mount");
	let r = !1, i = !0;
	e.root.unsettledCount++, e.root.dispatchUpdate(() => r ? i : (r = !0, n && e.root.changelog.length === 0 && !t.cell.isDirty && !t.hasEagerState && (t.prevState = t.cell.workInProgress, t.eagerState = n(t.cell.workInProgress, t.action), t.hasEagerState = !0, i = !Object.is(t.cell.current, t.eagerState), !i && !t.settled && (t.settled = !0, e.root.unsettledCount--)), i), () => (r = !0, i = !0, E(t), t.logged || (t.logged = !0, e.root.changelog.push(t)), !0));
}, Ae = (e, t, n, r, i) => {
	let a = r ? r(n) : n;
	S && e.devStrictMode && r && r(n);
	let o = {
		type: "reducer",
		workInProgress: a,
		current: a,
		isDirty: !1,
		queue: null,
		renderQueue: null,
		reducer: t,
		dispatch: (n) => {
			let r = x();
			if (r !== null) {
				if (r !== e) throw Error("Cannot update a resource while rendering a different resource.");
				(e.renderPendingCells ??= /* @__PURE__ */ new Set()).add(o), (o.renderQueue ??= []).push(n);
			} else ke(e, {
				fiber: e,
				cell: o,
				action: n,
				hasEagerState: !1,
				eagerState: void 0,
				prevState: o.current,
				settled: !1,
				queued: !1,
				logged: !1
			}, i ? t : void 0);
		}
	};
	return o;
};
function je(e, t, n, r) {
	let i = b(), a = i.currentIndex++, o = i.cells[a], s = (() => {
		if (o !== void 0) return o.type === "reducer" ? o : ae();
		i.isFirstRender || ie();
		let s = Ae(i, e, t, n, r);
		return i.cells[a] = s, s;
	})(), c = s.queue;
	if (c !== null) {
		let t = e === s.reducer;
		for (let n = 0; n < c.length; n++) {
			let r = c[n];
			!r.hasEagerState || !t || !Object.is(r.prevState, s.workInProgress) ? (r.prevState = s.workInProgress, r.eagerState = e(s.workInProgress, r.action), r.hasEagerState = !0, S && i.devStrictMode && (r.eagerState = e(s.workInProgress, r.action))) : S && i.devStrictMode && e(s.workInProgress, r.action), r.queued = !1, s.workInProgress = r.eagerState;
		}
		s.queue = null;
	}
	if (s.reducer = e, s.renderQueue !== null) {
		let t = s.workInProgress;
		for (let n of s.renderQueue) t = e(t, n);
		s.renderQueue = null, i.renderPendingCells?.delete(s), Object.is(t, s.workInProgress) || (k(i, s), s.workInProgress = t);
	}
	return s.isDirty && D(i, () => {
		s.current = s.workInProgress, s.isDirty = !1;
	}), [s.workInProgress, s.dispatch];
}
function Me(e, t, n) {
	return je(e, t, n, !1);
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/react-hooks/useState.js
var Ne = (e, t) => typeof t == "function" ? t(e) : t, Pe = (e) => e === void 0 ? void 0 : typeof e == "function" ? e() : e;
function Fe(e) {
	return je(Ne, e, Pe, !0);
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/react-hooks/useCallback.js
var Ie = (e, t) => ue(() => e, t);
//#endregion
//#region node_modules/@assistant-ui/tap/dist/react-hooks/useEffectEvent.js
function Le(e) {
	let t = b(), n = de(e);
	return n.current !== e && D(t, () => {
		n.current = e;
	}), Ie(((...e) => {
		if (S && x()) throw Error("useEffectEvent cannot be called during render");
		return n.current(...e);
	}), []);
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/helpers/thenable.js
var Re = (e) => typeof e == "object" && !!e && typeof e.then == "function", ze = () => {}, Be = (e) => {
	let t = e;
	switch (typeof t.status == "string" ? t.status !== "fulfilled" && t.status !== "rejected" && e.then(ze, ze) : (t.status = "pending", e.then((e) => {
		t.status === "pending" && (t.status = "fulfilled", t.value = e);
	}, (e) => {
		t.status === "pending" && (t.status = "rejected", t.reason = e);
	})), t.status) {
		case "fulfilled": return t.value;
		case "rejected": throw t.reason;
		default: throw e;
	}
}, Ve = (e) => Re(e) ? Be(e) : Ce(e), He = !1, Ue = (e, t, n = t) => {
	let r = b().isNeverMounted, i = r ? n() : t();
	S && !He && (!r || n === t) && (Object.is(i, t()) || (He = !0, console.error("The result of getSnapshot should be cached to avoid an infinite loop")));
	let [, a] = Me((e) => e + 1, 0), o = de(0), s = Le(() => {
		try {
			if (Object.is(i, t())) return o.current = 0, !1;
		} catch {}
		return !0;
	});
	return se(() => e(() => {
		s() && a();
	}), [e]), se(() => {
		if (s()) {
			if (++o.current > 50) throw o.current = 0, Error("Maximum update depth exceeded. The result of getSnapshot should be cached to avoid an infinite loop.");
			a();
		}
	}, [
		e,
		i,
		t
	]), i;
}, We = (e, t) => {}, Ge = 0, Ke = () => {
	let e = de(null);
	return e.current ??= `:tap${Ge++}:`, e.current;
}, qe = (e, t, n) => {
	let r = () => {
		if (!e) return;
		let n = t();
		if (typeof e == "function") {
			let t = e(n);
			return typeof t == "function" ? t : () => e(null);
		}
		return e.current = n, () => {
			e.current = null;
		};
	};
	n == null ? se(r) : se(r, [...n, e]);
}, Je = j.default;
function Ye(e) {
	let t = (0, j.useRef)(e);
	return (0, j.useInsertionEffect)(() => {
		t.current = e;
	}), (0, j.useCallback)(((...e) => t.current(...e)), []);
}
var Xe = Je.useEffectEvent ?? Ye, Ze = () => x() !== null, L = j.default, Qe = (e) => Ze() ? Fe(e) : L.useState(e), $e = (e, t, n) => Ze() ? Me(e, t, n) : L.useReducer(e, t, n), et = (e) => Ze() ? de(e) : L.useRef(e), tt = (e, t) => Ze() ? ue(e, t) : L.useMemo(e, t), nt = (e, t) => Ze() ? Ie(e, t) : L.useCallback(e, t), R = (e, t) => Ze() ? se(e, t) : L.useEffect(e, t), rt = (e, t) => Ze() ? se(e, t) : L.useLayoutEffect(e, t), it = (e) => Ze() ? Le(e) : Xe(e), at = (e, t, n) => Ze() ? Ue(e, t, n) : L.useSyncExternalStore(e, t, n), ot = (e, t) => Ze() ? void 0 : L.useDebugValue(e, t), st = (e, t) => Ze() ? se(e, t) : L.useInsertionEffect(e, t), ct = (e, t, n) => Ze() ? qe(e, t, n) : L.useImperativeHandle(e, t, n), lt = (e) => L.forwardRef(e), ut = (e, t) => L.memo(e, t), dt = L.Fragment, ft = (...e) => L.createElement(...e), pt = (...e) => L.cloneElement(...e), mt = (e) => L.isValidElement(e);
L.Children, L.Suspense;
var ht = (e) => {
	let t = L.createContext(e);
	return ge(t, e), t;
}, gt = (e) => Ze() && ye(e) ? Ve(e) : L.use(e), _t = (e) => Ze() && ye(e) ? Ve(e) : L.useContext(e);
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/resource.js
function vt(e) {
	return (...t) => ({
		hook: e,
		args: t
	});
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/withKey.js
function yt(e, t, n) {
	return typeof t == "function" ? (...n) => yt(e, t(...n)) : n ? {
		...t,
		key: e,
		deps: n
	} : {
		...t,
		key: e
	};
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/helpers/throwAggregated.js
var bt = (e, t) => {
	if (e.length !== 0) {
		if (e.length === 1) throw e[0];
		for (let t of e) console.error(t);
		throw AggregateError(e, t);
	}
}, xt = 50, St = {
	schedulers: /* @__PURE__ */ new Set(),
	isScheduled: !1
}, Ct = null, wt = [], Tt = class {
	_isDirty = !1;
	_task;
	constructor(e) {
		this._task = e;
	}
	get isDirty() {
		return this._isDirty;
	}
	markDirty() {
		if (Ct && (Ct.get(this) ?? 0) >= xt) throw Error("Maximum update depth exceeded. This can happen when a resource repeatedly calls setState inside useEffect.");
		this._isDirty = !0, St.schedulers.add(this), Ot();
	}
	runTask() {
		Ct?.set(this, (Ct.get(this) ?? 0) + 1), this._isDirty = !1, this._task();
	}
	settle() {
		this._isDirty = !1;
	}
}, Et = [];
new Tt(() => {
	let e = Et.splice(0), t = [];
	for (let n of e) try {
		n();
	} catch (e) {
		t.push(e);
	}
	bt(t, "Errors occurred while running scheduled tasks");
});
var Dt = (e) => {
	if (Ct !== null) {
		wt.push(e);
		return;
	}
	e();
}, Ot = () => {
	St.isScheduled || (St.isScheduled = !0, At());
}, kt = () => {
	let e = Ct;
	Ct = /* @__PURE__ */ new Map();
	let t = [];
	try {
		for (let e of St.schedulers) if (St.schedulers.delete(e), e.isDirty) try {
			e.runTask();
		} catch (e) {
			t.push(e);
		}
	} finally {
		if (Ct = e, St.schedulers.clear(), St.isScheduled = !1, Ct === null) for (; wt.length > 0;) try {
			wt.shift()();
		} catch (e) {
			t.push(e);
		}
	}
	bt(t, "Errors occurred during flushSync");
}, At = (() => {
	if (typeof MessageChannel < "u") {
		let e = null, t;
		return () => {
			if (!e) {
				let n = new MessageChannel();
				n.port1.onmessage = () => {
					e?.unref?.(), kt();
				}, e = n.port1, t = n.port2;
			}
			e.ref?.(), t.postMessage(null);
		};
	}
	return () => setTimeout(kt, 0);
})(), jt = (e) => {
	if (Ct !== null) return S && console.warn("flushTapSync was called from inside a render or commit. The flush is deferred until the current pass completes."), e();
	let t = St;
	St = {
		schedulers: /* @__PURE__ */ new Set(),
		isScheduled: !0
	};
	try {
		let t = e();
		return kt(), t;
	} finally {
		let e = St.schedulers;
		if (St = t, e.size > 0) {
			for (let t of e) St.schedulers.add(t);
			Ot();
		}
	}
};
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/helpers/commit.js
function Mt(e) {
	let t = [];
	for (let n = 0; n < e.length; n++) try {
		e[n]();
	} catch (e) {
		t.push(e);
	}
	bt(t, "Errors during commit");
}
function Nt(e) {
	let t = e.setup, n = e.setupDeps, r = e.generation, i;
	try {
		let e = t();
		if (e !== void 0 && typeof e != "function") throw Error(`An effect function must either return a cleanup function or nothing. Received: ${typeof e}`);
		i = e;
	} finally {
		e.generation === r ? (e.cleanup = i, e.deps = n) : i?.();
	}
}
var Pt = (e) => e.setup === void 0 ? !1 : e.deps === null || e.setupDeps === void 0 || !ce(e.deps, e.setupDeps);
function Ft(e) {
	let t = [], n = [];
	for (let t of e.effectCells) Pt(t) && n.push(t);
	for (let e of n) if (e.deps = null, e.cleanup !== void 0) try {
		e.cleanup();
	} catch (e) {
		t.push(e);
	} finally {
		e.cleanup = void 0;
	}
	for (let e of n) try {
		Nt(e);
	} catch (e) {
		t.push(e);
	}
	bt(t, "Errors during commit");
}
function It(e) {
	let t = [];
	for (let n of e.effectCells) if (n.deps = null, n.cleanup) try {
		n.cleanup?.();
	} catch (e) {
		t.push(e);
	} finally {
		n.cleanup = void 0;
	}
	bt(t, "Errors during cleanup");
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/react-dispatcher.js
var Lt = {
	useState: Fe,
	useReducer: Me,
	useRef: de,
	useMemo: ue,
	useCallback: Ie,
	useEffect: se,
	useLayoutEffect: se,
	useInsertionEffect: se,
	useEffectEvent: Le,
	useContext: Ce,
	use: Ve,
	useSyncExternalStore: Ue,
	useDebugValue: We,
	useId: Ke,
	useImperativeHandle: qe,
	useMemoCache: ne
}, Rt = j.default, zt = Rt.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ?? Rt.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED, Bt = zt == null ? null : "H" in zt ? {
	get current() {
		return zt.H;
	},
	set current(e) {
		zt.H = e;
	}
} : "ReactCurrentDispatcher" in zt ? {
	get current() {
		return zt.ReactCurrentDispatcher.current;
	},
	set current(e) {
		zt.ReactCurrentDispatcher.current = e;
	}
} : null;
function Vt(e) {
	if (!Bt) return e();
	let t = Bt.current;
	Bt.current = Lt;
	try {
		return e();
	} finally {
		Bt.current = t;
	}
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/core/ResourceFiber.js
function Ht(e, t, n = void 0, r) {
	return {
		hook: e,
		root: t,
		markDirty: n,
		devStrictMode: r,
		cells: [],
		effectCells: [],
		contextDeps: null,
		wipContextDeps: null,
		wipCommitCallbacks: null,
		memoCache: {
			current: null,
			workInProgress: null,
			index: 0
		},
		renderPendingCells: null,
		currentIndex: 0,
		isFirstRender: !0,
		isMounted: !1,
		isNeverMounted: !0
	};
}
function Ut(e) {
	e.wipCommitCallbacks = null, e.wipContextDeps = null, e.memoCache.workInProgress = null;
}
function Wt(e) {
	e.isMounted && (e.isMounted = !1, It(e));
}
function Gt(e, t) {
	if (e.renderPendingCells !== null) {
		for (let t of e.renderPendingCells) t.renderQueue = null;
		e.renderPendingCells.clear();
	}
	let n = 0, r;
	try {
		do {
			if (++n > 25) throw Error("Too many re-renders. tap limits the number of renders to prevent an infinite loop.");
			e.memoCache.index = 0, y(e, () => {
				r = Vt(() => e.hook(...t));
			});
		} while ((e.renderPendingCells?.size ?? 0) > 0);
	} catch (t) {
		throw Ut(e), t;
	}
	return Ee(e), r;
}
function z(e) {
	let t = e.wipCommitCallbacks;
	e.wipCommitCallbacks = null;
	let n = S && !e.isMounted && e.devStrictMode === "root";
	e.isMounted = !0, e.isNeverMounted = !1, t !== null && (e.contextDeps = e.wipContextDeps, w(e.root), e.memoCache.workInProgress !== null && (e.memoCache.current = e.memoCache.workInProgress, e.memoCache.workInProgress = null), Mt(t)), n && (Ft(e), It(e)), Ft(e);
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/hooks/utils/useDevStrictMode.js
var Kt = () => {
	let e = b();
	return e.devStrictMode ? e.isFirstRender ? "child" : "root" : null;
}, qt = () => "child", Jt = () => null, Yt = () => {
	if (!S) return Jt;
	let e = et(0);
	return Qe(() => e.current++), e.current === 2 ? qt : Jt;
}, Xt = () => x() ? Kt : Yt(), Zt = (e) => e(), Qt = (e) => {
	let t = [];
	for (let n of e) try {
		n();
	} catch (e) {
		t.push(e);
	}
	bt(t, "Errors occurred while notifying Tap root subscribers");
}, $t = (e, t, n) => {
	let r = new Tt(() => s.handleUpdate()), i = [], a = C((e, t) => {
		(i.length !== 0 || e()) && (i.push(t), r.markDirty());
	}), o = Ht(Zt, a, void 0, t), s = {
		scheduler: r,
		queue: i,
		fiber: o,
		subscribers: /* @__PURE__ */ new Set(),
		pendingHostRender: !1,
		isMounted: !1,
		hasRendered: !1,
		committedRender: e,
		context: /* @__PURE__ */ new Map(),
		value: void 0,
		applyQueue: () => {
			T(a, a.committedVersion);
			for (let e of i) S && o.devStrictMode && e(), e();
			return T(a, a.committedVersion + a.changelog.length), i.length;
		},
		publish: (e, t) => {
			r.isDirty || a.committedVersion !== t || s.value === e || (s.value = e, Dt(() => Qt(s.subscribers)));
		},
		finishFlush: (e, t, n) => {
			w(a), i.splice(0, n), s.pendingHostRender = !1, i.length === 0 && r.settle(), s.isMounted && z(o), s.publish(e, t);
		},
		handleUpdate: () => {
			let e = s.applyQueue(), t;
			try {
				S && o.devStrictMode && I(s.context, () => Gt(o, [s.committedRender])), t = I(s.context, () => Gt(o, [s.committedRender]));
			} catch (e) {
				if (T(a, a.committedVersion), Re(e)) {
					let t = () => {
						s.isMounted && r.markDirty();
					};
					e.then(t, t);
					return;
				}
				if (s.isMounted) {
					s.pendingHostRender = !0, n((e) => e + 1);
					return;
				}
				throw e;
			}
			if (r.isDirty) throw Error("Scheduler is dirty, this should never happen");
			s.finishFlush(t, a.version, e);
		}
	};
	return s;
}, en = (e) => {
	let [, t] = Qe(0), n = Xt(), r = et(null), i = r.current ??= $t(e, n(), t), a = F(), o = i.scheduler.isDirty || i.pendingHostRender ? i.applyQueue() : 0, s = I(a, () => Gt(i.fiber, [e])), c = {
		render: e,
		context: a,
		value: s,
		drained: o,
		wip: i.fiber.wipCommitCallbacks,
		version: i.fiber.root.version,
		processed: !1
	};
	return i.hasRendered || (i.hasRendered = !0, i.committedRender = e, i.context = a, i.value = s), R(() => (i.isMounted = !0, () => {
		i.isMounted = !1, Wt(i.fiber);
	}), [i]), R(() => {
		if (c.processed) {
			i.fiber.isMounted || (z(i.fiber), i.queue.length && !i.scheduler.isDirty && i.scheduler.markDirty());
			return;
		}
		if (c.processed = !0, i.committedRender = c.render, i.context = c.context, i.fiber.wipCommitCallbacks !== c.wip) {
			i.scheduler.isDirty || i.handleUpdate();
			return;
		}
		if (c.drained > 0 && i.fiber.root.version === c.version) {
			i.finishFlush(c.value, c.version, c.drained);
			return;
		}
		z(i.fiber), i.publish(c.value, c.version);
	}), tt(() => ({
		getValue: () => i.value,
		subscribe: (e) => (i.subscribers.add(e), () => i.subscribers.delete(e))
	}), [i]);
}, tn = () => {
	let e = et(0), t = e.current, n = b();
	return {
		version: t,
		markDirty: tt(() => () => {
			e.current++, n.markDirty?.();
		}, [n]),
		root: n.root
	};
}, nn = () => {
	let [e] = Qe(() => C((e, t) => {
		let i = !1;
		r((t) => (i = !e(), i ? t : t + 1)), i || n(t);
	})), [t, n] = $e((t, n) => (T(e, t), t + +!!n()), 0), [, r] = Qe(0);
	return T(e, t), {
		root: e,
		version: t,
		markDirty: void 0
	};
}, rn = () => {
	let e = Xt(), { root: t, version: n, markDirty: r } = x() ? tn() : nn();
	return {
		version: n,
		createFiber: nt((n, i, a) => Ht(n, t, a ? () => {
			a(), r?.();
		} : r, e()), [])
	};
}, an = (e, t, n) => {
	let r = et(null), i = r.current ??= {
		wipDeps: null,
		wip: null,
		currentDeps: null,
		current: null
	};
	return i.wipDeps = i.currentDeps, i.wip = i.current, R(() => {
		i.currentDeps = i.wipDeps, i.current = i.wip;
	}), !n && i.currentDeps && ce(i.currentDeps, t) ? i.current : (i.wipDeps = t, i.wip = e(), i.wip);
};
//#endregion
//#region node_modules/@assistant-ui/tap/dist/hooks/useResource.js
function on(e) {
	let { version: t, createFiber: n } = rn(), r = tt(() => n(e.hook, e.key), [
		e.hook,
		e.key,
		n
	]), i = an(() => ({ value: Gt(r, e.args) }), [
		r,
		t,
		e.args
	], Oe(r));
	return R(() => () => Wt(r), [r]), R(() => {
		z(r);
	}, [r, i]), i.value;
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/hooks/useResources.js
var sn = (e, t) => {
	let n = e.get(t);
	n && (n.isDirty = !0);
}, cn = (e, t) => !e.isDirty && !Oe(e.fiber) && t !== void 0 && e.committedDeps !== void 0 && ce(e.committedDeps, t), ln = (e) => {
	if (!De()) return !1;
	for (let { fiber: t } of e.values()) if (Oe(t)) return !0;
	return !1;
};
function un(e) {
	let [t] = Qe(() => /* @__PURE__ */ new Map()), { version: n, createFiber: r } = rn(), i = ln(t), a = an(() => {
		let n = /* @__PURE__ */ new Set(), i = [], a = 0;
		for (let o = 0; o < e.length; o++) {
			let s = e[o], c = s.key;
			if (c === void 0) throw Error(`useResources did not provide a key for array at index ${o}`);
			if (n.has(c)) throw Error(`Duplicate key ${c} in useResources`);
			n.add(c);
			let l = t.get(c);
			if (!l) {
				let e = r(s.hook, s.key, () => sn(t, c));
				l = {
					fiber: e,
					next: {
						value: Gt(e, s.args),
						deps: s.deps
					},
					isDirty: !1,
					committedDeps: void 0,
					committedValue: void 0
				}, a++, t.set(c, l);
			} else if (l.fiber.hook !== s.hook) {
				let e = r(s.hook, s.key, () => sn(t, c)), n = Gt(e, s.args);
				l.next = {
					value: n,
					deps: s.deps,
					remount: e
				};
			} else if (cn(l, s.deps)) typeof l.next == "object" && Ut(l.fiber), l.fiber.contextDeps && Ee(l.fiber, l.fiber.contextDeps), l.next = "skip";
			else {
				let e = Gt(l.fiber, s.args);
				l.next = {
					value: e,
					deps: s.deps
				};
			}
			i.push(typeof l.next == "object" ? l.next.value : l.committedValue);
		}
		if (t.size > i.length - a) for (let e of t.keys()) n.has(e) || (t.get(e).next = "delete");
		return i;
	}, [
		e,
		t,
		r,
		n
	], i);
	return R(() => () => {
		for (let e of t.keys()) Wt(t.get(e).fiber);
	}, [t]), R(() => {
		for (let [e, n] of t.entries()) {
			let r = n.next;
			r === "delete" ? (Wt(n.fiber), t.delete(e)) : r === "skip" ? !n.fiber.isNeverMounted && !n.fiber.isMounted && z(n.fiber) : (r.remount && (Wt(n.fiber), n.fiber = r.remount), z(n.fiber), n.committedDeps = r.deps, n.committedValue = r.value, n.isDirty = !1, n.next = "skip");
		}
	}, [a, t]), a;
}
//#endregion
//#region node_modules/@assistant-ui/tap/dist/hooks/useTapHost.js
var dn = (e) => e(), fn = (e) => {
	let { createFiber: t } = rn(), n = tt(() => t(dn, void 0), [t]), r = Gt(n, [e]);
	R(() => () => {
		Wt(n);
	}, [n]);
	let i = !1, a = () => {
		i && n.isMounted || (i = !0, z(n));
	};
	return R(a), {
		value: r,
		effects: a
	};
}, pn = vt(() => {
	let e = N(4), [t, n] = Qe(mn), r;
	e[0] === Symbol.for("react.memo_cache_sentinel") ? (r = (e, t) => (n((n) => {
		let r = P(n.renderers);
		return r[e] = [...r[e] ?? [], t], {
			...n,
			renderers: r
		};
	}), () => {
		n((n) => {
			let r = P(n.renderers), i = r[e]?.filter((e) => e !== t) ?? [];
			return i.length > 0 ? r[e] = i : delete r[e], {
				...n,
				renderers: r
			};
		});
	}), e[0] = r) : r = e[0];
	let i = r, a;
	e[1] === Symbol.for("react.memo_cache_sentinel") ? (a = (e) => (n((t) => ({
		...t,
		fallbacks: [...t.fallbacks, e]
	})), () => {
		n((t) => ({
			...t,
			fallbacks: t.fallbacks.filter((t) => t !== e)
		}));
	}), e[1] = a) : a = e[1];
	let o = a, s;
	return e[2] === t ? s = e[3] : (s = {
		getState: () => t,
		setDataUI: i,
		setFallbackDataUI: o
	}, e[2] = t, e[3] = s), s;
});
function mn() {
	return {
		renderers: P(),
		fallbacks: []
	};
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/model-context/types.js
var hn = (e) => {
	if (!e.overwrite) return e;
	let { overwrite: t, ...n } = e;
	return n;
}, gn = (e) => {
	let t = Array.from(e).map((e) => e.getModelContext()).sort((e, t) => (t.priority ?? 0) - (e.priority ?? 0)), n = P();
	return t.reduce((e, t) => {
		let r = t.priority ?? 0;
		if (t.system && (e.system ? e.system += `\n\n${t.system}` : e.system = t.system), t.tools) for (let [i, a] of Object.entries(t.tools)) {
			let t = e.tools !== void 0 && Object.hasOwn(e.tools, i) ? e.tools[i] : void 0;
			if (t && t !== a) {
				let o = n[i];
				if (o === r) {
					if (!a.overwrite) throw Error(`You tried to define a tool with the name ${i}, but it already exists.`);
					e.tools[i] = hn(a);
					continue;
				}
				let s = o > r ? t : a, c = o > r ? a : t;
				e.tools[i] = hn({
					...c,
					...s
				}), n[i] = Math.max(o, r);
				continue;
			}
			e.tools ||= P(), e.tools[i] = hn(a), Object.hasOwn(n, i) || (n[i] = r);
		}
		return t.config && (e.config = {
			...e.config,
			...t.config
		}), t.callSettings && (e.callSettings = {
			...e.callSettings,
			...t.callSettings
		}), t.unstable_composerMetadata && (e.unstable_composerMetadata = {
			...e.unstable_composerMetadata,
			...t.unstable_composerMetadata
		}), e;
	}, {});
}, _n = (e, t, n) => {
	let r = (e) => {
		console.error(`[assistant-ui] ${n} listener threw an error`, e);
	};
	for (let n of e) try {
		let e = n(typeof t == "function" ? t() : t);
		e !== null && (typeof e == "object" || typeof e == "function") && "then" in e && typeof e.then == "function" && Promise.resolve(e).catch(r);
	} catch (e) {
		r(e);
	}
}, vn = (e) => e, yn = /* @__PURE__ */ new Set([
	"$$typeof",
	"nodeType",
	"then",
	"__v_raw",
	"__v_isRef",
	"__v_isReactive",
	"__v_isReadonly",
	"__v_isShallow",
	"__v_skip"
]), bn = (e, t) => {
	if (e === Symbol.toStringTag) return t;
	if (typeof e != "symbol") {
		if (e === "toJSON") return () => t;
		if (!yn.has(e)) return !1;
	}
}, xn = class {
	getOwnPropertyDescriptor(e, t) {
		let n = this.get(e, t);
		if (n !== void 0) return {
			value: n,
			writable: !1,
			enumerable: !0,
			configurable: !0
		};
	}
	set() {
		return !1;
	}
	setPrototypeOf() {
		return !1;
	}
	defineProperty() {
		return !1;
	}
	deleteProperty() {
		return !1;
	}
	preventExtensions() {
		return !1;
	}
}, Sn = Symbol("assistant-ui.store.clientId"), Cn = Symbol("assistant-ui.store.instanceTag"), wn = (e, t) => {
	let n = new Proxy((() => {}), {
		apply: () => (t(), n),
		get: (n, r) => r === "source" ? e.source : r === "query" ? e.query : r === "name" ? e.name : r === Sn ? On(t()) : t()[r],
		has: (e, n) => n === "source" || n === "query" || n === "name" || n === Sn || n in t(),
		ownKeys: () => Reflect.ownKeys(t()),
		getOwnPropertyDescriptor: (e, n) => {
			if (typeof n != "symbol" && n in t()) return {
				value: t()[n],
				writable: !1,
				enumerable: !0,
				configurable: !0
			};
		}
	});
	return n;
}, Tn = (e, t) => {
	let n = () => {
		throw Error(e);
	};
	return new Proxy((() => {}), {
		apply: n,
		get: (e, r) => {
			if (r === "source" || r === "query") return null;
			if (r === "name") return t;
			if (r === Sn) return n();
			let i = bn(r, "AssistantClientAccessor");
			return i === !1 ? n() : i;
		},
		has: (e, t) => t === "source" || t === "query" || t === "name",
		ownKeys: () => [],
		getOwnPropertyDescriptor: () => void 0
	});
}, En = (e) => e?.source != null, Dn = (e) => e?.source === null, On = (e) => e[Sn] ?? e, kn = (e) => e[Cn] ?? On(e), An = (e) => e === "optional" || e === "subscribe" || e === "on" || e === "__proto__" || typeof e == "symbol", jn = (e) => {
	let t = [];
	for (let n in e) An(n) || t.push(n);
	return t;
}, Mn = class extends xn {
	#e;
	constructor(e) {
		super(), this.#e = e;
	}
	get(e, t) {
		let n = bn(t, "OptionalAssistantClient");
		if (n !== !1) return n;
		if (An(t)) return;
		let r = this.#e[t];
		return En(r) ? r : void 0;
	}
	ownKeys() {
		return jn(this.#e);
	}
	has(e, t) {
		return !An(t) && t in this.#e;
	}
}, Nn = (e) => new Proxy({}, new Mn(e)), Pn = () => () => {}, Fn = "You are using a component or hook that requires an AuiProvider. Wrap your component in an <AuiProvider> component.", In = class extends xn {
	#e;
	#t;
	#n;
	#r;
	constructor(e, t, n) {
		super(), this.#e = e, this.#t = t, this.#n = n;
	}
	get(e, t) {
		if (t === "subscribe" || t === "on") return Pn;
		if (t === "optional") return this.#r ??= Nn(this.#n());
		let n = bn(t, this.#e);
		return n === !1 ? Tn(this.#t(String(t)), String(t)) : n;
	}
	ownKeys() {
		return [
			"subscribe",
			"on",
			"optional"
		];
	}
	getOwnPropertyDescriptor(e, t) {
		if (t !== "optional") return super.getOwnPropertyDescriptor(e, t);
		let n = this.get(e, t);
		if (n !== void 0) return {
			value: n,
			writable: !1,
			enumerable: !1,
			configurable: !0
		};
	}
	has(e, t) {
		return t === "subscribe" || t === "on" || t === "optional";
	}
}, Ln = ((e, t) => {
	let n = new Proxy({}, new In(e, t, () => n));
	return n;
})("DefaultAssistantClient", () => Fn), Rn = () => new Proxy({}, { get(e, t) {
	let n = bn(t, "AssistantClient");
	return n === !1 ? Tn(`The current scope does not have a "${String(t)}" property.`, String(t)) : n;
} }), zn = ht(Ln), Bn = () => {}, Vn = /* @__PURE__ */ new WeakMap(), Hn = (e) => Vn.get(e) ?? Bn, Un = (e, t) => {
	Vn.set(e, t);
}, Wn = () => _t(zn), Gn = (e, t) => xe(zn, e, t), Kn = Symbol("assistant-ui.transform-scopes");
function qn(e, t) {
	let n = e;
	if (n[Kn]) throw Error("transformScopes is already attached to this resource");
	n[Kn] = t;
}
function Jn(e) {
	return e[Kn];
}
//#endregion
//#region node_modules/@assistant-ui/store/dist/types/events.js
var Yn = (e) => typeof e == "string" ? {
	scope: e.split(".")[0],
	event: e
} : {
	scope: e.scope,
	event: e.event
}, Xn = (e) => {
	console.error("NotificationManager: event listener error", e);
}, Zn = (e, t, n) => {
	try {
		let r = e(t, n);
		r !== null && (typeof r == "object" || typeof r == "function") && typeof r.then == "function" && Promise.resolve(r).catch(Xn);
	} catch (e) {
		Xn(e);
	}
}, Qn = () => {
	let e = /* @__PURE__ */ new Map(), t = /* @__PURE__ */ new Set(), n = /* @__PURE__ */ new Set();
	return {
		on(n, r) {
			let i = r;
			if (n === "*") return t.add(i), () => t.delete(i);
			let a = e.get(n);
			return a || (a = /* @__PURE__ */ new Set(), e.set(n, a)), a.add(i), () => {
				a.delete(i), a.size === 0 && e.get(n) === a && e.delete(n);
			};
		},
		emit(n, r, i) {
			(e.has(n) || t.size !== 0) && queueMicrotask(() => {
				let a = e.get(n);
				if (a) for (let e of a) Zn(e, r, i);
				if (t.size > 0) {
					let e = {
						event: n,
						payload: r
					};
					for (let n of t) Zn(n, e, i);
				}
			});
		},
		subscribe(e) {
			return n.add(e), () => n.delete(e);
		},
		notifySubscribers() {
			for (let e of n) try {
				e();
			} catch (e) {
				console.error("NotificationManager: subscriber callback error", e);
			}
		}
	};
}, $n = () => Qe(Qn)[0], er = Symbol("assistant-ui.store.clientIndex"), tr = (e) => e[er], nr = ht([]), rr = () => gt(nr), ir = (e, t) => {
	let n = N(3), r = rr(), i;
	return n[0] !== e || n[1] !== r ? (i = [...r, e], n[0] = e, n[1] = r, n[2] = i) : i = n[2], xe(nr, i, t);
}, ar = ht(null), or = Symbol("aui.scope-effect-unapplied"), sr = (e, t) => xe(ar, e, t), cr = () => {
	let e = gt(ar);
	if (!e) throw Error("AssistantTapContext is not available");
	return e;
}, lr = () => cr().clientRef, ur = (e, t, n) => {
	let r = N(8), { clientRef: i } = cr(), a;
	r[0] !== i || r[1] !== t || r[2] !== e ? (a = () => {
		let n = i.current;
		if (n === null) throw Error("useAssistantScopeEffect ran before the client was committed. This is likely an internal bug in assistant-ui.");
		let r = () => {
			let t = i.current?.[e];
			return t !== void 0 && En(t) ? kn(t) : void 0;
		}, a = or, o, s = (e) => {
			if (o?.(), o = void 0, a = or, e !== void 0) {
				let e = t();
				o = typeof e == "function" ? e : void 0;
			}
			a = e;
		};
		s(r());
		let c = n.subscribe(() => {
			let e = r();
			e !== a && s(e);
		});
		return () => {
			c(), o?.();
		};
	}, r[0] = i, r[1] = t, r[2] = e, r[3] = a) : a = r[3];
	let o;
	r[4] !== i || r[5] !== n || r[6] !== e ? (o = [
		i,
		e,
		...n
	], r[4] = i, r[5] = n, r[6] = e, r[7] = o) : o = r[7], R(a, o);
}, dr = () => {
	let e = N(3), { emit: t } = cr(), n = rr(), r;
	return e[0] !== n || e[1] !== t ? (r = (e, r) => {
		t(e, r, n);
	}, e[0] = n, e[1] = t, e[2] = r) : r = e[2], it(r);
}, fr = ht(void 0), pr = (e, t) => {
	let n = gt(fr);
	return xe(fr, e ?? n, t);
}, mr = () => {
	let e = N(3), [t] = Qe(hr), n, r;
	return e[0] === t ? (n = e[1], r = e[2]) : (n = () => () => queueMicrotask(() => t.abort()), r = [t], e[0] = t, e[1] = n, e[2] = r), st(n, r), t.signal;
};
function hr() {
	return new AbortController();
}
//#endregion
//#region node_modules/@assistant-ui/store/dist/useClientResource.js
var gr = Symbol("assistant-ui.store.getValue"), _r = (e) => {
	let t = e[gr];
	if (!t) throw Error("Client scope contains a non-client resource. Ensure your Derived get() returns a client created with useClientResource(), not a plain resource.");
	return t.getState?.();
}, vr = /* @__PURE__ */ new Map();
function yr(e) {
	let t = vr.get(e);
	return t || (t = function(...t) {
		if (!this || typeof this != "object") throw Error(`Method "${String(e)}" called without proper context. This may indicate the function was called incorrectly.`);
		let n = this[gr];
		if (!n) throw Error(`Method "${String(e)}" called on invalid client proxy. Ensure you are calling this method on a valid client instance.`);
		let r = n[e];
		if (!r) throw Error(`Method "${String(e)}" is not implemented.`);
		if (typeof r != "function") throw Error(`"${String(e)}" is not a function.`);
		return r(...t);
	}, vr.set(e, t)), t;
}
var br = class extends xn {
	boundFns;
	cachedReceiver;
	outputRef;
	tagRef;
	index;
	constructor(e, t, n) {
		super(), this.outputRef = e, this.tagRef = t, this.index = n;
	}
	get(e, t, n) {
		if (t === gr) return this.outputRef.current;
		if (t === er) return this.index;
		if (t === Cn) return this.tagRef.current;
		let r = bn(t, "ClientProxy");
		if (r !== !1) return r;
		let i = this.outputRef.current[t];
		if (typeof i == "function") {
			if (n === void 0) return i;
			(!this.boundFns || this.cachedReceiver !== n) && (this.boundFns = /* @__PURE__ */ new Map(), this.cachedReceiver = n);
			let e = this.boundFns.get(t);
			return e || (e = yr(t).bind(n), this.boundFns.set(t, e)), e;
		}
		return i;
	}
	ownKeys() {
		return Object.keys(this.outputRef.current);
	}
	has(e, t) {
		return t === gr || t === er || t === Cn || t in this.outputRef.current;
	}
}, xr = (e) => {
	let t = et(null), n = et(null), r = tt(() => ({}), [e.hook, e.key]), i = rr().length, a = tt(() => new Proxy({}, new br(t, n, i)), [i]), o = ir(a, function() {
		return on(e);
	});
	return t.current || (t.current = o, n.current = r), R(() => {
		t.current = o, n.current = r;
	}), {
		methods: a,
		state: o.getState?.(),
		key: e.key
	};
}, Sr = vt(xr), Cr = (e, t) => {
	if (Array.isArray(e) !== Array.isArray(t)) return !1;
	if (Array.isArray(e) && Array.isArray(t)) {
		if (e.length !== t.length) return !1;
		for (let n = 0; n < e.length; n++) if (!Object.is(e[n], t[n])) return !1;
		return !0;
	}
	let n = Object.keys(e);
	return n.length === Object.keys(t).length && n.every((n) => Object.hasOwn(t, n) && Object.is(e[n], t[n]));
}, wr = (e) => {
	let t = tt(() => ({}), []);
	return t.v !== void 0 && Cr(t.v, e) ? t.v : (t.v = e, e);
}, Tr = (e) => {
	let t = N(2), n = et(void 0), r;
	return t[0] === e ? r = t[1] : (r = (t) => {
		let r = e(t);
		return n.current !== void 0 && Cr(n.current, r) ? n.current : (n.current = r, r);
	}, t[0] = e, t[1] = r), r;
}, Er = (() => {
	try {
		return !1;
	} catch {
		return !1;
	}
})(), Dr = (e, t) => {
	let n = { ...e }, r = /* @__PURE__ */ new Set(), i = !0;
	for (; i;) {
		i = !1;
		for (let e of Object.values(n)) {
			if (r.has(e.hook)) continue;
			r.add(e.hook);
			let a = Jn(e.hook);
			if (a) {
				a(n, t), i = !0;
				break;
			}
		}
	}
	return n;
}, Or = (e) => e.hook === Qr, kr = (e) => {
	if (!Or(e)) return {
		source: "root",
		query: {}
	};
	let t = e.args[0];
	return {
		source: t.source,
		query: t.query ?? {}
	};
}, Ar = Symbol.for("aui.event-receiver-ref"), jr = (e, t) => {
	let n = e === Ln ? Rn() : e, r = Object.create(n);
	Object.assign(r, t);
	let i;
	return Object.defineProperty(r, "optional", {
		get: () => i ??= Nn(r),
		enumerable: !1
	}), r;
}, Mr = ({ notifications: e, clientRef: t }) => tt(() => ({
	subscribe: e.subscribe,
	on: function(n, r) {
		if (!this) throw Error("const { on } = useAui() is not supported. Use aui.on() instead.");
		let { scope: i, event: a } = Yn(n), o = n[Ar];
		if (i !== "*" && !o && Dn(this[i])) throw Error(`Scope "${i}" is not available. Use { scope: "*", event: "${a}" } to listen globally.`);
		let s = e.on(a, (e, n) => {
			if (i === "*") return r(e);
			let a = ((o ?? t).current ?? this)[i];
			if (!En(a)) return;
			let s = On(a);
			if (s === n[tr(s)]) return r(e);
		});
		if (i !== "*") {
			if (o) {
				if (t.parent === Ln) return s;
			} else if (Dn(t.parent[i])) return s;
		}
		let c = t.parent.on(n, r);
		return () => {
			s(), c();
		};
	}
}), [e, t]), Nr = (e) => {
	let t = N(5), n;
	t[0] === e ? n = t[1] : (n = kr(e), t[0] = e, t[1] = n);
	let { source: r, query: i } = n, a = wr(i), o;
	return t[2] !== r || t[3] !== a ? (o = {
		source: r,
		query: a
	}, t[2] = r, t[3] = a, t[4] = o) : o = t[4], wr(o);
}, Pr = (e, t) => {
	let n = N(3), r;
	return n[0] !== t || n[1] !== e ? (r = t ? e : Sr(e), n[0] = t, n[1] = e, n[2] = r) : r = n[2], on(r);
}, Fr = vt((e, t) => {
	let n = Wn(), r = Or(t), i = Pr(t, r), a = r ? i : i.methods, o = Nr(t), s = tt(() => wn({
		name: e,
		...o
	}, () => a), [
		e,
		o,
		a
	]);
	return n[e] = s, s;
}), Ir = (e) => {
	let t = N(2), n;
	return t[0] === e ? n = t[1] : (n = e.map(qr), t[0] = e, t[1] = n), un(n);
}, Lr = (e, t) => {
	let n = wr(t), r = tt(() => ({}), []);
	return r.deps !== n && (r.deps = n, r.client = e), r.client;
}, Rr = ({ parent: e, entries: t, clientRef: n, notifications: r }) => {
	let i = jr(e, Mr({
		notifications: r,
		clientRef: n
	}));
	return { client: Lr(i, [e, ...sr({
		clientRef: n,
		emit: r.emit
	}, function() {
		return Gn(i, function() {
			return Ir(t);
		});
	})]) };
}, zr = ({ parent: e, entries: t, destroySignal: n }) => {
	let r = et({
		parent: e,
		current: null
	}).current, { value: i, effects: a } = fn(function() {
		let i = $n(), { client: a } = pr(n, function() {
			return Rr({
				parent: e,
				entries: t,
				clientRef: r,
				notifications: i
			});
		});
		return R(() => e.subscribe(i.notifySubscribers), [e, i]), R(() => i.notifySubscribers()), a;
	});
	return st(() => {
		r.parent = e, r.current = i;
	}, [
		i,
		e,
		r
	]), {
		client: i,
		effects: a
	};
}, Br = ({ parent: e, entries: t, destroySignal: n }) => {
	let r = et({
		parent: e,
		current: null
	}).current, { value: i, effects: a } = fn(function() {
		let i = $n(), a = en(function() {
			return pr(n, function() {
				return Rr({
					parent: e,
					entries: t,
					clientRef: r,
					notifications: i
				});
			});
		}), o = at(a.subscribe, () => a.getValue().client, () => a.getValue().client);
		return R(() => {
			let t = () => jt(() => {
				r.current = a.getValue().client, i.notifySubscribers();
			}), n = a.subscribe(t), o = e.subscribe(t);
			return () => {
				n(), o();
			};
		}, [
			a,
			e,
			i
		]), o;
	});
	return st(() => {
		r.parent = e, r.current = i;
	}, [
		i,
		e,
		r
	]), {
		client: i,
		effects: a
	};
}, Vr = (e, t, n, r) => {
	let { get: i } = r.args[0], a = at(e.subscribe, () => i(e), () => i(e)), o = Nr(r), s = tt(() => wn({
		name: n,
		...o
	}, () => a), [
		n,
		o,
		a
	]);
	return t[n] = s, s;
}, Hr = (e, t) => {
	if (Er) {
		let [e] = Qe(() => t.map(([e]) => e).join(",")), n = t.find(([, e]) => !Or(e));
		if (n) throw Error(`Scope "${n[0]}" is a root scope but this useAui mounted derived-only; remount with a new key to change scope kinds.`);
		let r = t.map(([e]) => e).join(",");
		if (r !== e) throw Error(`A derived-only config mounted scopes [${e}] but now has [${r}]; remount with a new key to change the scope set.`);
	}
	let n = et({
		parent: e,
		current: null
	}).current, r = jr(e, {
		subscribe: e.subscribe,
		on: function(t, r) {
			if (!this) throw Error("const { on } = useAui() is not supported. Use aui.on() instead.");
			let { scope: i, event: a } = Yn(t);
			if (i === "*") return e.on(t, r);
			let o = t[Ar];
			if (!o && Dn(this[i])) throw Error(`Scope "${i}" is not available. Use { scope: "*", event: "${a}" } to listen globally.`);
			return e.on({
				scope: i,
				event: a,
				[Ar]: o ?? n
			}, r);
		}
	}), i = Lr(r, [e, ...t.map(([t, n]) => Vr(e, r, t, n))]);
	return st(() => {
		n.parent = e, n.current = i;
	}, [
		i,
		e,
		n
	]), i;
}, Ur = (e, t) => {
	let n = N(8), r;
	n[0] !== t || n[1] !== e ? (r = Object.entries(Dr(t, e)), n[0] = t, n[1] = e, n[2] = r) : r = n[2];
	let i = r, a;
	n[3] === i ? a = n[4] : (a = () => i.length === 0 || i.some(Jr), n[3] = i, n[4] = a);
	let [o] = Qe(a), s;
	return n[5] !== i || n[6] !== o ? (s = {
		entries: i,
		rooted: o
	}, n[5] = i, n[6] = o, n[7] = s) : s = n[7], s;
}, Wr = (e, t, n, r) => {
	let { entries: i, rooted: a } = Ur(e, t);
	return a ? n({
		parent: e,
		entries: i,
		destroySignal: r
	}) : { client: Hr(e, i) };
}, Gr = (e, t, n) => Wr(e, t, zr, n);
function Kr(e) {
	let t = Wn();
	if (e) {
		let { client: n, effects: r } = Wr(t, e, Br, mr());
		return r && Un(n, r), n;
	}
	return t;
}
function qr(e) {
	let [t, n] = e;
	return yt(t, Fr(t, n));
}
function Jr(e) {
	let [, t] = e;
	return !Or(t);
}
//#endregion
//#region node_modules/@assistant-ui/store/dist/utils/proxied-assistant-state.js
var Yr = (e) => {
	let t;
	class n extends xn {
		get(t, n) {
			let r = bn(n, "OptionalAssistantState");
			if (r !== !1) return r;
			let i = n;
			if (!An(i) && En(e[i])) return _r(e[i]());
		}
		ownKeys() {
			return jn(e);
		}
		has(t, n) {
			return !An(n) && n in e;
		}
	}
	class r extends xn {
		get(r, i) {
			let a = bn(i, "AssistantState");
			if (a !== !1) return a;
			if (i === "optional") return t ??= new Proxy({}, new n());
			let o = i;
			if (!An(o)) return _r(e[o]());
		}
		ownKeys() {
			return [...jn(e), "optional"];
		}
		has(t, n) {
			return n === "optional" || !An(n) && n in e;
		}
	}
	return new Proxy({}, new r());
}, Xr = /* @__PURE__ */ new WeakMap(), Zr = (e) => {
	let t = Xr.get(e);
	return t || (t = Yr(e), Xr.set(e, t)), t;
}, B = (e) => {
	let t = N(6), n = Kr(), r;
	t[0] === n ? r = t[1] : (r = Zr(n), t[0] = n, t[1] = r);
	let i = r, a, o;
	t[2] !== i || t[3] !== e ? (a = () => e(i), o = () => e(i), t[2] = i, t[3] = e, t[4] = a, t[5] = o) : (a = t[4], o = t[5]);
	let s = at(n.subscribe, a, o);
	if (typeof s == "object" && s && (s === i || s === i.optional)) throw Error("You tried to return the entire AssistantState. This is not supported due to technical limitations.");
	return ot(s), s;
}, Qr = (e) => {
	let t = N(3), { get: n } = e, r = Kr(), i;
	return t[0] !== r || t[1] !== n ? (i = () => n(r), t[0] = r, t[1] = n, t[2] = i) : i = t[2], B(i);
}, $r = vt(Qr), ei = (e) => {
	if (e.key === void 0) throw Error("useClientLookup: Element has no key");
	return e.key;
};
function ti(e) {
	let t = N(12), n;
	t[0] === e ? n = t[1] : (n = e.map(ii), t[0] = e, t[1] = n);
	let r = un(n), i;
	t[2] === e ? i = t[3] : (i = e.reduce(ri, Object.create(null)), t[2] = e, t[3] = i);
	let a = i, o;
	t[4] === r ? o = t[5] : (o = r.map(ni), t[4] = r, t[5] = o);
	let s = o, c;
	t[6] !== a || t[7] !== r ? (c = (e) => {
		if ("index" in e) {
			if (e.index < 0 || e.index >= r.length) throw Error(`useClientLookup: index ${e.index} out of bounds (length: ${r.length}) (ignore if recovered)`);
			return r[e.index].methods;
		}
		let t = a[e.key];
		if (t === void 0) throw Error(`useClientLookup: key "${e.key}" not found (ignore if recovered)`);
		return r[t].methods;
	}, t[6] = a, t[7] = r, t[8] = c) : c = t[8];
	let l;
	return t[9] !== s || t[10] !== c ? (l = {
		state: s,
		get: c
	}, t[9] = s, t[10] = c, t[11] = l) : l = t[11], l;
}
function ni(e) {
	return e.state;
}
function ri(e, t, n) {
	return e[ei(t)] = n, e;
}
function ii(e) {
	return yt(ei(e), Sr(e), e.deps);
}
//#endregion
//#region node_modules/@assistant-ui/store/dist/utils/viewport-scroll.js
var ai = (e, t = 0) => t === 0 ? Math.abs(e.scrollHeight - e.scrollTop - e.clientHeight) <= 1 || e.scrollHeight <= e.clientHeight : e.scrollHeight - t - e.scrollTop - e.clientHeight <= 1 || e.scrollHeight - t <= e.clientHeight, oi = (e, t = 0) => t === 0 ? e.scrollHeight > e.clientHeight + 1 : e.scrollHeight - t > e.clientHeight + 1, si = (e, t) => e.scrollTop > t.scrollTop && e.scrollHeight === t.scrollHeight, ci = Symbol("skip-update"), li = (e, ...t) => {
	let n = [];
	for (let r of e) try {
		r(...t);
	} catch (e) {
		n.push(e);
	}
	if (n.length === 1) throw n[0];
	if (n.length > 1) {
		for (let e of n) console.error(e);
		throw AggregateError(n);
	}
}, ui = (e) => {
	li(e);
}, di = (e, t) => e === void 0 || t === void 0 ? e === t : Cr(e, t), fi = class {
	_subscribers = /* @__PURE__ */ new Set();
	subscribe(e) {
		return this._subscribers.add(e), () => this._subscribers.delete(e);
	}
	waitForUpdate() {
		return new Promise((e) => {
			let t = this.subscribe(() => {
				t(), e();
			});
		});
	}
	_notifySubscribers() {
		li(this._subscribers);
	}
}, pi = class {
	_subscriptions = /* @__PURE__ */ new Set();
	_connection;
	get isConnected() {
		return !!this._connection;
	}
	notifySubscribers(e, t) {
		if (t) {
			_n(this._subscriptions, e, t);
			return;
		}
		li(this._subscriptions, e);
	}
	_updateConnection() {
		if (this._subscriptions.size > 0) {
			if (this._connection) return;
			this._connection = this._connect();
		} else {
			let e = this._connection;
			this._connection = void 0, e?.();
		}
	}
	subscribe(e) {
		return this._subscriptions.add(e), this._updateConnection(), () => {
			this._subscriptions.delete(e), this._updateConnection();
		};
	}
}, mi = class extends pi {
	get path() {
		return this.binding.path;
	}
	binding;
	constructor(e) {
		super(), this.binding = e;
		let t = e.getState();
		if (t === ci) throw Error("Entry not available in the store");
		this._previousState = t;
	}
	_previousState;
	getState = () => (this.isConnected || this._syncState(), this._previousState);
	_syncState() {
		let e = this.binding.getState();
		return e === ci || di(e, this._previousState) ? !1 : (this._previousState = e, !0);
	}
	_connect() {
		let e = this.binding.subscribe(() => {
			this._syncState() && this.notifySubscribers();
		});
		return this._syncState(), e;
	}
}, hi = class extends pi {
	get path() {
		return this.binding.path;
	}
	binding;
	constructor(e) {
		super(), this.binding = e;
	}
	_previousStateDirty = !0;
	_previousState;
	getState = () => {
		if (!this.isConnected || this._previousStateDirty) {
			let e = this.binding.getState();
			e !== ci && (this._previousState === void 0 || !di(e, this._previousState)) && (this._previousState = e), this._previousStateDirty = !1;
		}
		if (this._previousState === void 0) throw Error("Entry not available in the store");
		return this._previousState;
	};
	_connect() {
		let e = this.binding.subscribe(() => {
			this._previousStateDirty = !0, this.notifySubscribers();
		});
		return this._previousStateDirty = !0, e;
	}
}, gi = class extends pi {
	get path() {
		return this.binding.path;
	}
	binding;
	constructor(e) {
		super(), this.binding = e;
	}
	getState() {
		return this.binding.getState();
	}
	outerSubscribe(e) {
		return this.binding.subscribe(e);
	}
	_connect() {
		let e = () => {
			this.notifySubscribers();
		}, t = this.binding.getState(), n = t?.subscribe(e), r = this.outerSubscribe(() => {
			let r = this.binding.getState();
			if (r === t) return;
			t = r;
			let i = n;
			n = void 0;
			try {
				i?.();
			} finally {
				n = r?.subscribe(e), e();
			}
		});
		return () => ui([() => r?.(), () => n?.()]);
	}
}, _i = class extends pi {
	config;
	constructor(e) {
		super(), this.config = e;
	}
	getState() {
		return this.config.binding.getState();
	}
	outerSubscribe(e) {
		return this.config.binding.subscribe(e);
	}
	_connect() {
		let e = `Runtime event "${this.config.event}"`, t = (t) => {
			this.notifySubscribers(t, e);
		}, n = this.config.binding.getState(), r = n?.unstable_on(this.config.event, t), i = this.outerSubscribe(() => {
			let e = this.config.binding.getState();
			if (e === n) return;
			n = e;
			let i = r;
			r = void 0;
			try {
				i?.();
			} finally {
				r = e?.unstable_on(this.config.event, t);
			}
		});
		return () => ui([() => i?.(), () => r?.()]);
	}
}, vi = class {
	_providers = /* @__PURE__ */ new Map();
	_providerUnsubscribes = /* @__PURE__ */ new Map();
	getModelContext() {
		return gn(new Set(this._providers.values()));
	}
	registerModelContextProvider(e) {
		let t = Symbol();
		this._providers.set(t, e);
		let n;
		try {
			n = e.subscribe?.(() => {
				this.notifySubscribers();
			});
		} catch (e) {
			this._providers.delete(t);
			try {
				this.notifySubscribers();
			} catch (e) {
				console.error(e);
			}
			throw e;
		}
		this._providerUnsubscribes.set(t, n), this.notifySubscribers();
		let r = !1;
		return () => {
			if (r) return;
			r = !0, this._providers.delete(t);
			let e = this._providerUnsubscribes.get(t);
			this._providerUnsubscribes.delete(t);
			let n = !1, i, a = (e) => {
				try {
					e();
				} catch (e) {
					n ? console.error(e) : (n = !0, i = e);
				}
			};
			if (e && a(e), a(() => this.notifySubscribers()), n) throw i;
		};
	}
	_subscribers = /* @__PURE__ */ new Set();
	notifySubscribers() {
		li(this._subscribers);
	}
	subscribe(e) {
		return this._subscribers.add(e), () => {
			this._subscribers.delete(e);
		};
	}
}, yi = [], bi = {
	modelName: void 0,
	toolNames: yi
}, xi = (e, t) => e === t || Cr(e, t), Si = (e, t) => {
	let n = e.getModelContext(), r = n.config?.modelName, i = n.tools ? Object.keys(n.tools).sort() : yi, a = i.length ? i : yi;
	return r === t.modelName && xi(a, t.toolNames) ? t : {
		modelName: r,
		toolNames: a
	};
}, Ci = vt(() => {
	let e = N(11), t;
	e[0] === Symbol.for("react.memo_cache_sentinel") ? (t = new vi(), e[0] = t) : t = e[0];
	let n = t, r;
	e[1] === Symbol.for("react.memo_cache_sentinel") ? (r = () => Si(n, bi), e[1] = r) : r = e[1];
	let [i, a] = Qe(r), o, s;
	e[2] === Symbol.for("react.memo_cache_sentinel") ? (o = () => (a((e) => Si(n, e)), n.subscribe(() => {
		a((e) => Si(n, e));
	})), s = [n], e[2] = o, e[3] = s) : (o = e[2], s = e[3]), R(o, s);
	let c;
	e[4] === i ? c = e[5] : (c = () => Si(n, i), e[4] = i, e[5] = c);
	let l, u, d;
	e[6] === Symbol.for("react.memo_cache_sentinel") ? (l = () => n.getModelContext(), u = (e) => n.subscribe(e), d = (e) => n.registerModelContextProvider(e), e[6] = l, e[7] = u, e[8] = d) : (l = e[6], u = e[7], d = e[8]);
	let f;
	return e[9] === c ? f = e[10] : (f = {
		getState: c,
		getModelContext: l,
		subscribe: u,
		register: d
	}, e[9] = c, e[10] = f), f;
}), wi = (e, t) => {
	if (t.status?.type !== "running" && t.status?.type !== "requires-action") {
		let n = e.complete;
		return typeof n == "function" ? n({
			args: t.args,
			result: t.result
		}) : n ?? null;
	}
	let n = e.running;
	return typeof n == "function" ? n({ args: t.args }) : n ?? null;
}, Ti = (e) => e.display === void 0 ? e.type === "human" : e.display === "standalone", Ei = (e) => function(t) {
	return wi(e, t);
}, Di = (e) => {
	let t = N(16), { toolkit: n, mcpApp: r } = e, i;
	t[0] === r ? i = t[1] : (i = r ? [yt("mcpApp", r)] : [], t[0] = r, t[1] = i);
	let a = un(i)[0], [o, s] = Qe(ki), c;
	t[2] !== a || t[3] !== o ? (c = {
		toolUIs: o,
		mcpApp: a
	}, t[2] = a, t[3] = o, t[4] = c) : c = t[4];
	let l = c, u = lr(), d;
	t[5] === Symbol.for("react.memo_cache_sentinel") ? (d = (e, t, n) => {
		let r = {
			render: t,
			renderText: n?.renderText,
			standalone: n?.standalone ?? !1
		};
		return s((t) => {
			let n = P(t);
			return n[e] = [...n[e] ?? [], r], n;
		}), () => {
			s((t) => {
				let n = t[e]?.filter((e) => e !== r) ?? [], i = P(t);
				return n.length > 0 ? (i[e] = n, i) : (delete i[e], i);
			});
		};
	}, t[5] = d) : d = t[5];
	let f = d, p, m;
	t[6] === n ? (p = t[7], m = t[8]) : (p = () => {
		if (!n) return;
		let e = [];
		for (let [t, r] of Object.entries(n)) {
			let n = "render" in r ? r.render : void 0, i = "renderText" in r ? r.renderText : void 0, a = n ?? (i ? Ei(i) : void 0);
			a && e.push(f(t, a, {
				standalone: Ti(r),
				renderText: i
			}));
		}
		return () => {
			e.forEach(Ai);
		};
	}, m = [n, f], t[6] = n, t[7] = p, t[8] = m), R(p, m);
	let h;
	t[9] !== u || t[10] !== n ? (h = () => {
		if (!n) return;
		let e = Object.entries(n).reduce(ji, P());
		return u.current.modelContext().register({ getModelContext: () => ({ tools: e }) });
	}, t[9] = u, t[10] = n, t[11] = h) : h = t[11];
	let g;
	t[12] === n ? g = t[13] : (g = [n], t[12] = n, t[13] = g), ur("modelContext", h, g);
	let _;
	return t[14] === l ? _ = t[15] : (_ = {
		getState: () => l,
		setToolUI: f
	}, t[14] = l, t[15] = _), _;
}, Oi = vt(Di);
qn(Di, (e, t) => {
	!e.modelContext && t.modelContext.source === null && (e.modelContext = Ci());
});
function ki() {
	return P();
}
function Ai(e) {
	return e();
}
function ji(e, t) {
	let [n, r] = t;
	if (r.type === "mcp") return e;
	let { display: i, render: a, renderText: o, ...s } = r;
	return e[n] = s, e;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/store/runtime-clients/useSubscribable.js
var Mi = (e) => at(e.subscribe, e.getState, e.getServerSnapshot), Ni = Symbol.for("assistant-ui.silent-runtime-action"), Pi = (e) => typeof e == "object" && !!e && Ni in e, Fi = (e, t) => {
	let n = t();
	return n.catch((t) => {
		Pi(t) || console.error(`[assistant-ui] ${e} failed:`, t);
	}), n;
}, Ii = vt((e) => {
	let t = N(9), { runtime: n } = e, r = Mi(n), i;
	t[0] === r ? i = t[1] : (i = () => r, t[0] = r, t[1] = i);
	let a, o;
	t[2] === n ? (a = t[3], o = t[4]) : (a = () => Fi("attachment remove", n.remove), o = () => n, t[2] = n, t[3] = a, t[4] = o);
	let s;
	return t[5] !== i || t[6] !== a || t[7] !== o ? (s = {
		getState: i,
		remove: a,
		__internal_getRuntime: o
	}, t[5] = i, t[6] = a, t[7] = o, t[8] = s) : s = t[8], s;
}), Li = vt((e) => {
	let t = N(5), { runtime: n, index: r } = e, i;
	t[0] !== r || t[1] !== n ? (i = n.getAttachmentByIndex(r), t[0] = r, t[1] = n, t[2] = i) : i = t[2];
	let a = i, o;
	return t[3] === a ? o = t[4] : (o = Ii({ runtime: a }), t[3] = a, t[4] = o), on(o);
}), Ri = vt(({ item: e, onMove: t, onRemove: n }) => ({
	getState: () => e,
	steer: () => t({
		lane: "steer",
		insertAfter: null
	}),
	move: t,
	remove: n
})), zi = vt((e) => {
	let t = N(63), { threadIdRef: n, messageIdRef: r, runtime: i, isSuggestion: a } = e, o = Mi(i), s = dr(), c = et(!1), l, u;
	t[0] !== s || t[1] !== r || t[2] !== i || t[3] !== n ? (l = () => {
		let e = [], t = i.unstable_on("send", (e) => {
			let t = c.current;
			c.current = !1, s("composer.send", {
				threadId: n.current,
				...r && { messageId: r.current },
				chars: e.chars,
				attachments: e.attachments,
				...t ? { suggestion: !0 } : void 0
			});
		});
		e.push(t);
		let a = i.unstable_on("attachmentAdd", (e) => {
			s("composer.attachmentAdd", {
				threadId: n.current,
				...r && { messageId: r.current },
				...e.contentType ? { contentType: e.contentType } : void 0
			});
		});
		return e.push(a), e.push(i.unstable_on("attachmentAddError", (e) => {
			s("composer.attachmentAddError", {
				threadId: n.current,
				...r && { messageId: r.current },
				...e.attachmentId && { attachmentId: e.attachmentId },
				reason: e.reason,
				message: e.message,
				...e.contentType ? { contentType: e.contentType } : void 0
			});
		})), () => {
			for (let t of e) t();
		};
	}, u = [
		i,
		s,
		n,
		r
	], t[0] = s, t[1] = r, t[2] = i, t[3] = n, t[4] = l, t[5] = u) : (l = t[4], u = t[5]), R(l, u);
	let d;
	if (t[6] !== i || t[7] !== o.attachments) {
		let e;
		t[9] === i ? e = t[10] : (e = (e, t) => yt(e.id, Li({
			runtime: i,
			index: t
		}), [i, t]), t[9] = i, t[10] = e), d = o.attachments.map(e), t[6] = i, t[7] = o.attachments, t[8] = d;
	} else d = t[8];
	let f = ti(d), p = o.queue, m;
	if (t[11] !== p || t[12] !== i) {
		let e;
		t[14] === i ? e = t[15] : (e = (e) => yt(e.id, Ri({
			item: e,
			onMove: (t) => i.moveQueueItem(e.id, t),
			onRemove: () => i.removeQueueItem(e.id)
		})), t[14] = i, t[15] = e), m = p.map(e), t[11] = p, t[12] = i, t[13] = m;
	} else m = t[13];
	let h = ti(m), g = o.type ?? "thread", _;
	t[16] !== f.state || t[17] !== p || t[18] !== o.attachmentAccept || t[19] !== o.canCancel || t[20] !== o.canSend || t[21] !== o.dictation || t[22] !== o.isEditing || t[23] !== o.isEmpty || t[24] !== o.quote || t[25] !== o.role || t[26] !== o.runConfig || t[27] !== o.text || t[28] !== g ? (_ = {
		text: o.text,
		role: o.role,
		attachments: f.state,
		runConfig: o.runConfig,
		isEditing: o.isEditing,
		canCancel: o.canCancel,
		canSend: o.canSend,
		attachmentAccept: o.attachmentAccept,
		isEmpty: o.isEmpty,
		type: g,
		dictation: o.dictation,
		quote: o.quote,
		queue: p
	}, t[16] = f.state, t[17] = p, t[18] = o.attachmentAccept, t[19] = o.canCancel, t[20] = o.canSend, t[21] = o.dictation, t[22] = o.isEditing, t[23] = o.isEmpty, t[24] = o.quote, t[25] = o.role, t[26] = o.runConfig, t[27] = o.text, t[28] = g, t[29] = _) : _ = t[29];
	let v = _, y;
	t[30] === v ? y = t[31] : (y = () => v, t[30] = v, t[31] = y);
	let b;
	t[32] !== a || t[33] !== i ? (b = (e) => {
		let t = i.getState();
		c.current = t.canSend && (a?.(t.text) ?? !1), i.send(e);
	}, t[32] = a, t[33] = i, t[34] = b) : b = t[34];
	let x;
	t[35] !== s || t[36] !== r || t[37] !== i || t[38] !== n ? (x = () => {
		!r && i.getState().canCancel && s("composer.cancel", { threadId: n.current }), i.cancel();
	}, t[35] = s, t[36] = r, t[37] = i, t[38] = n, t[39] = x) : x = t[39];
	let S = i.beginEdit ?? Bi, C;
	t[40] === f ? C = t[41] : (C = (e) => "id" in e ? f.get({ key: e.id }) : f.get(e), t[40] = f, t[41] = C);
	let w;
	t[42] === h ? w = t[43] : (w = (e) => "id" in e ? h.get({ key: e.id }) : h.get(e), t[42] = h, t[43] = w);
	let T;
	t[44] === i ? T = t[45] : (T = () => i, t[44] = i, t[45] = T);
	let E;
	return t[46] !== i.addAttachment || t[47] !== i.clearAttachments || t[48] !== i.reset || t[49] !== i.setQuote || t[50] !== i.setRole || t[51] !== i.setRunConfig || t[52] !== i.setText || t[53] !== i.startDictation || t[54] !== i.stopDictation || t[55] !== S || t[56] !== C || t[57] !== w || t[58] !== T || t[59] !== y || t[60] !== b || t[61] !== x ? (E = {
		getState: y,
		setText: i.setText,
		setRole: i.setRole,
		setRunConfig: i.setRunConfig,
		addAttachment: i.addAttachment,
		reset: i.reset,
		clearAttachments: i.clearAttachments,
		send: b,
		cancel: x,
		beginEdit: S,
		startDictation: i.startDictation,
		stopDictation: i.stopDictation,
		setQuote: i.setQuote,
		attachment: C,
		queueItem: w,
		__internal_getRuntime: T
	}, t[46] = i.addAttachment, t[47] = i.clearAttachments, t[48] = i.reset, t[49] = i.setQuote, t[50] = i.setRole, t[51] = i.setRunConfig, t[52] = i.setText, t[53] = i.startDictation, t[54] = i.stopDictation, t[55] = S, t[56] = C, t[57] = w, t[58] = T, t[59] = y, t[60] = b, t[61] = x, t[62] = E) : E = t[62], E;
});
function Bi() {
	throw Error("beginEdit is not supported in this runtime");
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/store/runtime-clients/liveRef.js
var Vi = (e) => ({ get current() {
	return e();
} }), Hi = vt((e) => {
	let t = N(13), { runtime: n } = e, r = Mi(n), i;
	t[0] === r ? i = t[1] : (i = () => r, t[0] = r, t[1] = i);
	let a, o, s, c;
	t[2] === n ? (a = t[3], o = t[4], s = t[5], c = t[6]) : (a = (e) => n.addToolResult(e), o = (e) => n.resumeToolCall(e), s = (e) => n.respondToToolApproval(e), c = () => n, t[2] = n, t[3] = a, t[4] = o, t[5] = s, t[6] = c);
	let l;
	return t[7] !== i || t[8] !== a || t[9] !== o || t[10] !== s || t[11] !== c ? (l = {
		getState: i,
		addToolResult: a,
		resumeToolCall: o,
		respondToToolApproval: s,
		__internal_getRuntime: c
	}, t[7] = i, t[8] = a, t[9] = o, t[10] = s, t[11] = c, t[12] = l) : l = t[12], l;
}), Ui = vt((e) => {
	let t = N(5), { runtime: n, index: r } = e, i;
	t[0] !== r || t[1] !== n ? (i = n.getAttachmentByIndex(r), t[0] = r, t[1] = n, t[2] = i) : i = t[2];
	let a = i, o;
	return t[3] === a ? o = t[4] : (o = Ii({ runtime: a }), t[3] = a, t[4] = o), on(o);
}), Wi = vt((e) => {
	let t = N(5), { runtime: n, index: r } = e, i;
	t[0] !== r || t[1] !== n ? (i = n.getMessagePartByIndex(r), t[0] = r, t[1] = n, t[2] = i) : i = t[2];
	let a = i, o;
	return t[3] === a ? o = t[4] : (o = Hi({ runtime: a }), t[3] = a, t[4] = o), on(o);
}), Gi = vt((e) => {
	let t = N(74), { runtime: n, threadIdRef: r, threadId: i } = e, a = Mi(n), o = dr(), [s, c] = Qe(!1), [l, u] = Qe(!1), d;
	t[0] === n ? d = t[1] : (d = Vi(() => n.getState().id), t[0] = n, t[1] = d);
	let f = d, p = et(a.status), m;
	t[2] !== o || t[3] !== n || t[4] !== i ? (m = (e) => {
		o(e, {
			threadId: i,
			messageId: n.getState().id
		});
	}, t[2] = o, t[3] = n, t[4] = i, t[5] = m) : m = t[5];
	let h = m, g, _;
	t[6] !== o || t[7] !== a.id || t[8] !== a.status || t[9] !== i ? (g = () => {
		let e = a.status, t = p.current;
		p.current = e, e?.type === "incomplete" && e.reason === "error" && (t?.type !== "incomplete" || t.reason !== "error") && o("message.error", {
			threadId: i,
			messageId: a.id,
			reason: "error"
		});
	}, _ = [
		a.status,
		a.id,
		o,
		i
	], t[6] = o, t[7] = a.id, t[8] = a.status, t[9] = i, t[10] = g, t[11] = _) : (g = t[10], _ = t[11]), R(g, _);
	let v;
	t[12] !== f || t[13] !== n.composer || t[14] !== r ? (v = zi({
		runtime: n.composer,
		threadIdRef: r,
		messageIdRef: f
	}), t[12] = f, t[13] = n.composer, t[14] = r, t[15] = v) : v = t[15];
	let y = xr(v), b;
	if (t[16] !== n || t[17] !== a.content) {
		let e;
		t[19] === n ? e = t[20] : (e = (e, t) => yt("toolCallId" in e && e.toolCallId != null ? `toolCallId-${e.toolCallId}` : `index-${t}`, Wi({
			runtime: n,
			index: t
		}), [n, t]), t[19] = n, t[20] = e), b = a.content.map(e), t[16] = n, t[17] = a.content, t[18] = b;
	} else b = t[18];
	let x = ti(b), S;
	t[21] === a.attachments ? S = t[22] : (S = a.attachments ?? [], t[21] = a.attachments, t[22] = S);
	let C;
	if (t[23] !== n || t[24] !== S) {
		let e;
		t[26] === n ? e = t[27] : (e = (e, t) => yt(e.id, Ui({
			runtime: n,
			index: t
		}), [n, t]), t[26] = n, t[27] = e), C = S.map(e), t[23] = n, t[24] = S, t[25] = C;
	} else C = t[25];
	let w = ti(C), T = a, E;
	t[28] !== y.state || t[29] !== s || t[30] !== l || t[31] !== x.state || t[32] !== T ? (E = {
		...T,
		parts: x.state,
		composer: y.state,
		isCopied: s,
		isHovering: l
	}, t[28] = y.state, t[29] = s, t[30] = l, t[31] = x.state, t[32] = T, t[33] = E) : E = t[33];
	let D = E, O;
	t[34] === D ? O = t[35] : (O = () => D, t[34] = D, t[35] = O);
	let k;
	t[36] === y.methods ? k = t[37] : (k = () => y.methods, t[36] = y.methods, t[37] = k);
	let ee;
	t[38] === n ? ee = t[39] : (ee = () => n.delete(), t[38] = n, t[39] = ee);
	let A, te;
	t[40] !== h || t[41] !== n ? (A = (e) => (h("message.reload"), n.reload(e)), te = () => (h("message.speak"), n.speak()), t[40] = h, t[41] = n, t[42] = A, t[43] = te) : (A = t[42], te = t[43]);
	let ne, j;
	t[44] === n ? (ne = t[45], j = t[46]) : (ne = () => n.stopSpeaking(), j = (e) => n.submitFeedback(e), t[44] = n, t[45] = ne, t[46] = j);
	let M;
	t[47] !== h || t[48] !== n ? (M = (e) => (h("message.branchSwitched"), n.switchToBranch(e)), t[47] = h, t[48] = n, t[49] = M) : M = t[49];
	let re;
	t[50] === n ? re = t[51] : (re = () => n.unstable_getCopyText(), t[50] = n, t[51] = re);
	let P;
	t[52] === x ? P = t[53] : (P = (e) => "index" in e ? x.get({ index: e.index }) : x.get({ key: `toolCallId-${e.toolCallId}` }), t[52] = x, t[53] = P);
	let ie;
	t[54] === w ? ie = t[55] : (ie = (e) => "id" in e ? w.get({ key: e.id }) : w.get(e), t[54] = w, t[55] = ie);
	let ae;
	t[56] === h ? ae = t[57] : (ae = (e) => {
		e && h("message.copied"), c(e);
	}, t[56] = h, t[57] = ae);
	let oe;
	t[58] === n ? oe = t[59] : (oe = () => n, t[58] = n, t[59] = oe);
	let se;
	return t[60] !== O || t[61] !== k || t[62] !== ee || t[63] !== A || t[64] !== te || t[65] !== ne || t[66] !== j || t[67] !== M || t[68] !== re || t[69] !== P || t[70] !== ie || t[71] !== ae || t[72] !== oe ? (se = {
		getState: O,
		composer: k,
		delete: ee,
		reload: A,
		speak: te,
		stopSpeaking: ne,
		submitFeedback: j,
		switchToBranch: M,
		getCopyText: re,
		part: P,
		attachment: ie,
		setIsCopied: ae,
		setIsHovering: u,
		__internal_getRuntime: oe
	}, t[60] = O, t[61] = k, t[62] = ee, t[63] = A, t[64] = te, t[65] = ne, t[66] = j, t[67] = M, t[68] = re, t[69] = P, t[70] = ie, t[71] = ae, t[72] = oe, t[73] = se) : se = t[73], se;
}), Ki = (e) => {
	let t = tt(() => ({}), []), n = t.state, r = [];
	e.suggestions.forEach((e) => {
		let t = n?.suggestions[r.length];
		r.push(t && Cr(t, e) ? t : e);
	});
	let i = n && Cr(r, n.suggestions) ? n : { suggestions: r };
	return t.state = i, i;
}, qi = vt((e) => ({ getState: () => e })), Ji = (e) => {
	let t = N(9), n = Ki(e), r;
	t[0] === n.suggestions ? r = t[1] : (r = n.suggestions.map(Xi), t[0] = n.suggestions, t[1] = r);
	let i = ti(r), a;
	t[2] === n ? a = t[3] : (a = () => n, t[2] = n, t[3] = a);
	let o;
	t[4] === i ? o = t[5] : (o = (e) => {
		let { index: t } = e;
		return i.get({ index: t });
	}, t[4] = i, t[5] = o);
	let s;
	return t[6] !== a || t[7] !== o ? (s = {
		getState: a,
		suggestion: o
	}, t[6] = a, t[7] = o, t[8] = s) : s = t[8], s;
}, Yi = vt((e) => {
	let t = N(4), n;
	t[0] === e ? n = t[1] : (n = e.map(Zi), t[0] = e, t[1] = n);
	let r;
	return t[2] === n ? r = t[3] : (r = { suggestions: n }, t[2] = n, t[3] = r), Ji(r);
});
function Xi(e, t) {
	return yt(t, qi(e), [e]);
}
function Zi(e) {
	return {
		title: e.title ?? e.prompt,
		label: e.label ?? "",
		prompt: e.prompt
	};
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/utils/normalizePartStatus.js
var Qi = Object.freeze({ type: "complete" }), $i = Object.freeze({ type: "running" }), ea = Object.freeze({
	cancelled: Object.freeze({
		type: "incomplete",
		reason: "cancelled"
	}),
	length: Object.freeze({
		type: "incomplete",
		reason: "length"
	}),
	"content-filter": Object.freeze({
		type: "incomplete",
		reason: "content-filter"
	}),
	other: Object.freeze({
		type: "incomplete",
		reason: "other"
	}),
	error: Object.freeze({
		type: "incomplete",
		reason: "error"
	})
}), ta = (e) => {
	let t = e.status;
	if (!t || typeof t != "object") return;
	let { type: n } = t;
	if (n === "running") return $i;
	if (n === "complete") return Qi;
	if (n !== "incomplete") return;
	let { reason: r } = t;
	return ea[r === "cancelled" || r === "length" || r === "content-filter" || r === "other" || r === "error" ? r : "other"];
}, na = (e, t, n) => {
	if (e.role !== "assistant") return Qi;
	if (n.type === "tool-call") return n.result === void 0 ? e.status : Qi;
	if (e.status.type === "running") {
		let e = ta(n);
		if (e) return e;
	}
	let r = t === Math.max(0, e.content.length - 1);
	return e.status.type === "requires-action" ? Qi : r ? e.status : Qi;
}, ra = (e) => "reason" in e ? e.reason : void 0, V = (e) => "error" in e ? e.error : void 0, ia = 32, aa = /* @__PURE__ */ new WeakMap(), oa = (e) => aa.get(e) ?? e.id, sa = (e, t, n) => "status" in e && e.status ? na(e, t, n) : Qi, ca = () => {
	let e = [], t = /* @__PURE__ */ new Map();
	return (n) => {
		let r = [], i = /* @__PURE__ */ new Map(), a = !0, o = (e, n, s, c) => {
			if (!(s > ia)) for (let [l, u] of e.entries()) for (let [e, d] of u.content.entries()) {
				if (d.type !== "tool-call" || d.messages === void 0) continue;
				let f = d.messages, p = sa(u, e, d), m = ra(p), h = V(p), g = `${c}${l}.${e}`, _ = t.get(g), v = _?.part === d && _.statusType === p.type && _.statusReason === m && Object.is(_.statusError, h) && _.messages === f && _.task.messageId === u.id && _.task.parentTaskId === n && _.task.depth === s ? _.task : {
					id: d.toolCallId,
					toolName: d.toolName,
					args: d.args,
					result: d.result,
					...d.isError === void 0 ? void 0 : { isError: d.isError },
					status: p,
					timing: d.timing,
					messageId: u.id,
					parentTaskId: n,
					depth: s,
					messages: f
				};
				v !== _?.task && (a = !1, aa.set(v, g)), r.push(v), i.set(g, {
					task: v,
					part: d,
					statusType: p.type,
					statusReason: m,
					statusError: h,
					messages: f
				}), o(f, v.id, s + 1, `${g}.`);
			}
		};
		o(n, null, 0, "");
		let s = a && r.length === e.length && r.every((t, n) => t === e[n]) ? e : r;
		return e = s, t = i, s;
	};
}, la = vt(({ task: e }) => ({ getState: () => e })), ua = vt((e) => {
	let t = N(7), { runtime: n, id: r, threadIdRef: i, threadId: a } = e, o;
	t[0] !== r || t[1] !== n ? (o = n.getMessageById(r), t[0] = r, t[1] = n, t[2] = o) : o = t[2];
	let s = o, c;
	return t[3] !== s || t[4] !== a || t[5] !== i ? (c = Gi({
		runtime: s,
		threadIdRef: i,
		threadId: a
	}), t[3] = s, t[4] = a, t[5] = i, t[6] = c) : c = t[6], on(c);
}), da = vt((e) => {
	let t = N(93), { runtime: n } = e, r = Mi(n), i = dr(), a, o;
	t[0] !== i || t[1] !== n ? (a = () => {
		let e = [];
		for (let t of [
			"runStart",
			"runEnd",
			"initialize",
			"modelContextUpdate"
		]) {
			let r = n.unstable_on(t, () => {
				let e = n.getState()?.threadId || "unknown";
				i(`thread.${t}`, { threadId: e });
			});
			e.push(r);
		}
		return e.push(n.unstable_on("toolApprovalAnswered", (e) => {
			let t = n.getState()?.threadId || "unknown";
			i("thread.toolApprovalAnswered", {
				threadId: t,
				...e
			});
		})), () => {
			for (let t of e) t();
		};
	}, o = [n, i], t[0] = i, t[1] = n, t[2] = a, t[3] = o) : (a = t[2], o = t[3]), R(a, o);
	let s;
	t[4] === n ? s = t[5] : (s = Vi(() => n.getState().threadId), t[4] = n, t[5] = s);
	let c = s, l;
	t[6] !== i || t[7] !== n ? (l = (e) => {
		i(e, { threadId: n.getState().threadId });
	}, t[6] = i, t[7] = n, t[8] = l) : l = t[8];
	let u = l, d;
	t[9] === n ? d = t[10] : (d = (e) => n.getState().suggestions.some((t) => t.prompt === e), t[9] = n, t[10] = d);
	let f = d, p;
	t[11] !== f || t[12] !== n.composer || t[13] !== c ? (p = zi({
		runtime: n.composer,
		threadIdRef: c,
		isSuggestion: f
	}), t[11] = f, t[12] = n.composer, t[13] = c, t[14] = p) : p = t[14];
	let m = xr(p), h;
	t[15] === r.suggestions ? h = t[16] : (h = Yi(r.suggestions), t[15] = r.suggestions, t[16] = h);
	let g = xr(h), _;
	t[17] === Symbol.for("react.memo_cache_sentinel") ? (_ = ca(), t[17] = _) : _ = t[17];
	let v = _, y;
	t[18] === r.messages ? y = t[19] : (y = v(r.messages), t[18] = r.messages, t[19] = y);
	let b = y, x;
	t[20] === b ? x = t[21] : (x = b.map(fa), t[20] = b, t[21] = x);
	let S = ti(x), C;
	if (t[22] !== n || t[23] !== r.messages || t[24] !== r.threadId || t[25] !== c) {
		let e;
		t[27] !== n || t[28] !== r.threadId || t[29] !== c ? (e = (e) => yt(e.id, ua({
			runtime: n,
			id: e.id,
			threadIdRef: c,
			threadId: r.threadId
		}), [
			n,
			e.id,
			c,
			r.threadId
		]), t[27] = n, t[28] = r.threadId, t[29] = c, t[30] = e) : e = t[30], C = r.messages.map(e), t[22] = n, t[23] = r.messages, t[24] = r.threadId, t[25] = c, t[26] = C;
	} else C = t[26];
	let w = ti(C), T = w.state.length === 0 && !r.isLoading, E;
	t[31] !== m.state || t[32] !== w.state || t[33] !== r.capabilities || t[34] !== r.extras || t[35] !== r.isDisabled || t[36] !== r.isLoading || t[37] !== r.isRunning || t[38] !== r.speech || t[39] !== r.state || t[40] !== r.suggestions || t[41] !== r.voice || t[42] !== T || t[43] !== b ? (E = {
		isEmpty: T,
		isDisabled: r.isDisabled,
		isLoading: r.isLoading,
		isRunning: r.isRunning,
		capabilities: r.capabilities,
		state: r.state,
		suggestions: r.suggestions,
		extras: r.extras,
		speech: r.speech,
		voice: r.voice,
		composer: m.state,
		messages: w.state,
		tasks: b
	}, t[31] = m.state, t[32] = w.state, t[33] = r.capabilities, t[34] = r.extras, t[35] = r.isDisabled, t[36] = r.isLoading, t[37] = r.isRunning, t[38] = r.speech, t[39] = r.state, t[40] = r.suggestions, t[41] = r.voice, t[42] = T, t[43] = b, t[44] = E) : E = t[44];
	let D = E, O;
	t[45] === D ? O = t[46] : (O = () => D, t[45] = D, t[46] = O);
	let k;
	t[47] === m.methods ? k = t[48] : (k = () => m.methods, t[47] = m.methods, t[48] = k);
	let ee;
	t[49] === g ? ee = t[50] : (ee = () => g.methods, t[49] = g, t[50] = ee);
	let A;
	t[51] !== S || t[52] !== b ? (A = (e) => {
		if ("id" in e) {
			let t = b.find((t) => t.id === e.id);
			return S.get({ key: t ? oa(t) : e.id });
		}
		return S.get(e);
	}, t[51] = S, t[52] = b, t[53] = A) : A = t[53];
	let te;
	t[54] !== i || t[55] !== f || t[56] !== n ? (te = (e) => {
		let t = typeof e == "string" ? { content: [{
			type: "text",
			text: e
		}] } : e;
		if ((t.role ?? "user") === "user") {
			let e = t.content.map(pa).join("");
			i("composer.send", {
				threadId: n.getState().threadId,
				chars: e.length,
				attachments: t.attachments?.length ?? 0,
				...f(e) ? { suggestion: !0 } : void 0
			});
		}
		n.append(e);
	}, t[54] = i, t[55] = f, t[56] = n, t[57] = te) : te = t[57];
	let ne;
	t[58] !== u || t[59] !== n || t[60] !== r.isRunning ? (ne = () => {
		r.isRunning && u("thread.cancelRun"), n.cancelRun();
	}, t[58] = u, t[59] = n, t[60] = r.isRunning, t[61] = ne) : ne = t[61];
	let j;
	t[62] !== u || t[63] !== n ? (j = () => {
		n.connectVoice(), u("thread.voiceStarted");
	}, t[62] = u, t[63] = n, t[64] = j) : j = t[64];
	let M;
	t[65] === w ? M = t[66] : (M = (e) => "id" in e ? w.get({ key: e.id }) : w.get(e), t[65] = w, t[66] = M);
	let re;
	t[67] === n ? re = t[68] : (re = () => n, t[67] = n, t[68] = re);
	let P;
	return t[69] !== n.deleteMessage || t[70] !== n.disconnectVoice || t[71] !== n.export || t[72] !== n.getModelContext || t[73] !== n.getVoiceVolume || t[74] !== n.import || t[75] !== n.importExternalState || t[76] !== n.muteVoice || t[77] !== n.reset || t[78] !== n.resumeRun || t[79] !== n.startRun || t[80] !== n.stopSpeaking || t[81] !== n.subscribeVoiceVolume || t[82] !== n.unmuteVoice || t[83] !== O || t[84] !== k || t[85] !== ee || t[86] !== A || t[87] !== te || t[88] !== ne || t[89] !== j || t[90] !== M || t[91] !== re ? (P = {
		getState: O,
		composer: k,
		suggestions: ee,
		task: A,
		append: te,
		deleteMessage: n.deleteMessage,
		startRun: n.startRun,
		resumeRun: n.resumeRun,
		importExternalState: n.importExternalState,
		cancelRun: ne,
		getModelContext: n.getModelContext,
		export: n.export,
		import: n.import,
		reset: n.reset,
		stopSpeaking: n.stopSpeaking,
		connectVoice: j,
		disconnectVoice: n.disconnectVoice,
		getVoiceVolume: n.getVoiceVolume,
		subscribeVoiceVolume: n.subscribeVoiceVolume,
		muteVoice: n.muteVoice,
		unmuteVoice: n.unmuteVoice,
		message: M,
		__internal_getRuntime: re
	}, t[69] = n.deleteMessage, t[70] = n.disconnectVoice, t[71] = n.export, t[72] = n.getModelContext, t[73] = n.getVoiceVolume, t[74] = n.import, t[75] = n.importExternalState, t[76] = n.muteVoice, t[77] = n.reset, t[78] = n.resumeRun, t[79] = n.startRun, t[80] = n.stopSpeaking, t[81] = n.subscribeVoiceVolume, t[82] = n.unmuteVoice, t[83] = O, t[84] = k, t[85] = ee, t[86] = A, t[87] = te, t[88] = ne, t[89] = j, t[90] = M, t[91] = re, t[92] = P) : P = t[92], P;
});
function fa(e) {
	return yt(oa(e), la({ task: e }), [e]);
}
function pa(e) {
	return e.type === "text" ? e.text : "";
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/store/runtime-clients/handle-thread-list-action.js
var ma = (e, t) => Fi(`thread list ${e}`, t), ha = vt((e) => {
	let t = N(35), { runtime: n, mainThreadIsRunning: r } = e, i = r !== void 0 && r, a = Mi(n), o;
	bb0: {
		let e = a.isRunning || a.isMain && i;
		if (e === a.isRunning) {
			o = a;
			break bb0;
		}
		let n;
		t[0] !== e || t[1] !== a ? (n = {
			...a,
			isRunning: e
		}, t[0] = e, t[1] = a, t[2] = n) : n = t[2], o = n;
	}
	let s = o, c = dr(), { isMain: l, id: u } = a, d;
	t[3] !== l || t[4] !== u ? (d = {
		isMain: l,
		threadId: u
	}, t[3] = l, t[4] = u, t[5] = d) : d = t[5];
	let f = et(d), p, m;
	t[6] !== c || t[7] !== l || t[8] !== u ? (p = () => {
		let e = f.current;
		(e.isMain !== l || e.threadId !== u) && (f.current = {
			isMain: l,
			threadId: u
		}, c(l ? "threadListItem.switchedTo" : "threadListItem.switchedAway", { threadId: u }));
	}, m = [
		l,
		u,
		c
	], t[6] = c, t[7] = l, t[8] = u, t[9] = p, t[10] = m) : (p = t[9], m = t[10]), R(p, m);
	let h;
	t[11] === s ? h = t[12] : (h = () => s, t[11] = s, t[12] = h);
	let g, _, v, y, b, x, S;
	t[13] === n ? (g = t[14], _ = t[15], v = t[16], y = t[17], b = t[18], x = t[19], S = t[20]) : (b = (e) => ma("switch", () => n.switchTo(e)), x = (e) => ma("rename", () => n.rename(e)), S = (e) => ma("update custom metadata", () => n.updateCustom(e)), g = () => ma("archive", () => n.archive()), _ = () => ma("unarchive", () => n.unarchive()), v = () => ma("delete", () => n.delete()), y = (e) => ma("generate title", () => n.generateTitle(e)), t[13] = n, t[14] = g, t[15] = _, t[16] = v, t[17] = y, t[18] = b, t[19] = x, t[20] = S);
	let C;
	t[21] === n ? C = t[22] : (C = () => n, t[21] = n, t[22] = C);
	let w;
	return t[23] !== n.detach || t[24] !== n.initialize || t[25] !== g || t[26] !== _ || t[27] !== v || t[28] !== y || t[29] !== C || t[30] !== h || t[31] !== b || t[32] !== x || t[33] !== S ? (w = {
		getState: h,
		switchTo: b,
		rename: x,
		updateCustom: S,
		archive: g,
		unarchive: _,
		delete: v,
		generateTitle: y,
		initialize: n.initialize,
		detach: n.detach,
		__internal_getRuntime: C
	}, t[23] = n.detach, t[24] = n.initialize, t[25] = g, t[26] = _, t[27] = v, t[28] = y, t[29] = C, t[30] = h, t[31] = b, t[32] = x, t[33] = S, t[34] = w) : w = t[34], w;
}), ga = (e) => {
	let t = N(4), n = dr(), r = et(e), i, a;
	t[0] !== n || t[1] !== e ? (i = () => {
		let t = r.current;
		t !== e && (r.current = e, n("threads.selectionChanged", {
			threadId: e,
			previousThreadId: t
		}));
	}, a = [e, n], t[0] = n, t[1] = e, t[2] = i, t[3] = a) : (i = t[2], a = t[3]), R(i, a);
}, _a = vt((e) => {
	let t = N(6), { runtime: n, id: r, mainThreadIsRunning: i } = e, a;
	t[0] !== r || t[1] !== n ? (a = n.getItemById(r), t[0] = r, t[1] = n, t[2] = a) : a = t[2];
	let o = a, s;
	return t[3] !== i || t[4] !== o ? (s = ha({
		runtime: o,
		mainThreadIsRunning: i
	}), t[3] = i, t[4] = o, t[5] = s) : s = t[5], on(s);
}), va = vt((e) => {
	let t = N(48), { runtime: n, __internal_assistantRuntime: r } = e, i = Mi(n);
	ga(i.mainThreadId);
	let a = dr(), o, s;
	t[0] !== a || t[1] !== n ? (o = () => n.unstable_subscribeThreadEvents((e) => {
		let { threadId: t, type: r } = e;
		t !== n.getState().mainThreadId && a(`thread.${r}`, { threadId: t });
	}), s = [n, a], t[0] = a, t[1] = n, t[2] = o, t[3] = s) : (o = t[2], s = t[3]), R(o, s);
	let c;
	t[4] === n.main ? c = t[5] : (c = da({ runtime: n.main }), t[4] = n.main, t[5] = c);
	let l = xr(c), u;
	t[6] !== l.state || t[7] !== n || t[8] !== i.threadItems ? (u = Object.keys(i.threadItems).map((e) => yt(e, _a({
		runtime: n,
		id: e,
		mainThreadIsRunning: l.state.isRunning
	}), [
		n,
		e,
		l.state.isRunning
	])), t[6] = l.state, t[7] = n, t[8] = i.threadItems, t[9] = u) : u = t[9];
	let d = ti(u), f = i.newThreadId ?? null, p;
	t[10] !== l.state || t[11] !== i.archivedThreadIds || t[12] !== i.hasMore || t[13] !== i.isLoading || t[14] !== i.isLoadingMore || t[15] !== i.loadError || t[16] !== i.mainThreadId || t[17] !== i.threadIds || t[18] !== f || t[19] !== d.state ? (p = {
		mainThreadId: i.mainThreadId,
		newThreadId: f,
		isLoading: i.isLoading,
		loadError: i.loadError,
		isLoadingMore: i.isLoadingMore,
		hasMore: i.hasMore,
		threadIds: i.threadIds,
		archivedThreadIds: i.archivedThreadIds,
		threadItems: d.state,
		main: l.state
	}, t[10] = l.state, t[11] = i.archivedThreadIds, t[12] = i.hasMore, t[13] = i.isLoading, t[14] = i.isLoadingMore, t[15] = i.loadError, t[16] = i.mainThreadId, t[17] = i.threadIds, t[18] = f, t[19] = d.state, t[20] = p) : p = t[20];
	let m = p, h;
	t[21] === m ? h = t[22] : (h = () => m, t[21] = m, t[22] = h);
	let g;
	t[23] === l.methods ? g = t[24] : (g = () => l.methods, t[23] = l.methods, t[24] = g);
	let _;
	t[25] !== m || t[26] !== d ? (_ = (e) => {
		if (e === "main") return d.get({ key: m.mainThreadId });
		if ("id" in e) return d.get({ key: e.id });
		let { index: t, archived: n } = e, r = n !== void 0 && n ? m.archivedThreadIds[t] : m.threadIds[t];
		return d.get({ key: r });
	}, t[25] = m, t[26] = d, t[27] = _) : _ = t[27];
	let v, y, b, x, S, C;
	t[28] === n ? (v = t[29], y = t[30], b = t[31], x = t[32], S = t[33], C = t[34]) : (v = (e, t) => ma("switch", () => n.switchToThread(e, t)), y = () => ma("create", () => n.switchToNewThread()), b = () => n.getLoadThreadsPromise(), x = () => n.reload(), S = () => n.reloadMainThread(), C = () => n.loadMore(), t[28] = n, t[29] = v, t[30] = y, t[31] = b, t[32] = x, t[33] = S, t[34] = C);
	let w;
	t[35] === r ? w = t[36] : (w = () => r, t[35] = r, t[36] = w);
	let T;
	return t[37] !== v || t[38] !== y || t[39] !== b || t[40] !== x || t[41] !== S || t[42] !== C || t[43] !== w || t[44] !== h || t[45] !== g || t[46] !== _ ? (T = {
		getState: h,
		thread: g,
		item: _,
		switchToThread: v,
		switchToNewThread: y,
		getLoadThreadsPromise: b,
		reload: x,
		reloadMainThread: S,
		loadMore: C,
		__internal_getAssistantRuntime: w
	}, t[37] = v, t[38] = y, t[39] = b, t[40] = x, t[41] = S, t[42] = C, t[43] = w, t[44] = h, t[45] = g, t[46] = _, t[47] = T) : T = t[47], T;
}), ya = (e, t) => {
	e.thread ??= $r({
		source: "threads",
		query: { type: "main" },
		get: (e) => e.threads.thread("main")
	}), e.threadListItem ??= $r({
		source: "threads",
		query: { type: "main" },
		get: (e) => e.threads.item("main")
	}), e.composer ??= $r({
		source: "thread",
		query: {},
		get: (e) => e.threads.thread("main").composer()
	}), !e.modelContext && t.modelContext.source === null && (e.modelContext = Ci()), !e.suggestions && t.suggestions.source === null && (e.suggestions = $r({
		source: "thread",
		query: {},
		get: (e) => e.thread.suggestions()
	}));
}, ba = (e) => {
	let t = N(7), n = lr(), r;
	t[0] !== n || t[1] !== e ? (r = () => e.registerModelContextProvider(n.current.modelContext()), t[0] = n, t[1] = e, t[2] = r) : r = t[2];
	let i;
	t[3] === e ? i = t[4] : (i = [e], t[3] = e, t[4] = i), ur("modelContext", r, i);
	let a;
	return t[5] === e ? a = t[6] : (a = va({
		runtime: e.threads,
		__internal_assistantRuntime: e
	}), t[5] = e, t[6] = a), on(a);
}, xa = vt(ba);
qn(ba, (e, t) => {
	ya(e, t), !e.tools && t.tools.source === null && (e.tools = Oi({})), !e.dataRenderers && t.dataRenderers.source === null && (e.dataRenderers = pn());
});
//#endregion
//#region node_modules/react/cjs/react-jsx-runtime.production.js
var Sa = /* @__PURE__ */ o(((e) => {
	var t = Symbol.for("react.transitional.element"), n = Symbol.for("react.fragment");
	function r(e, n, r) {
		var i = null;
		if (r !== void 0 && (i = "" + r), n.key !== void 0 && (i = "" + n.key), "key" in n) for (var a in r = {}, n) a !== "key" && (r[a] = n[a]);
		else r = n;
		return n = r.ref, {
			$$typeof: t,
			type: e,
			key: i,
			ref: n === void 0 ? null : n,
			props: r
		};
	}
	e.Fragment = n, e.jsx = r, e.jsxs = r;
})), H = (/* @__PURE__ */ o(((e, t) => {
	t.exports = Sa();
})))(), Ca = vn({}), wa = ({ effects: e }) => {
	"use no memo";
	return rt(e), null;
}, Ta = lt(function(e, t) {
	"use no memo";
	let { config: n, children: r } = e, i = "extends" in e, a = "value" in e, o = Wn();
	if (Er) {
		if (i && a) throw Error("AuiProvider: pass either `extends` or `value`, not both.");
		if (i && e.extends === void 0) throw Error("AuiProvider: `extends` must be a client or null, not undefined.");
		if (i && !n) throw Error("AuiProvider: `extends` requires a `config`.");
		if (a && n) throw Error("AuiProvider: pass either `value` or `config`, not both.");
		if (!a && !n) throw Error("AuiProvider: a `config` is required.");
		if (!i && !a && o !== Ln) throw Error("A parent AuiProvider exists — pass extends={aui} to inherit it or extends={null} to isolate.");
	}
	let s = i ? e.extends ?? Ln : a ? e.value ?? Ln : o, c = mr(), { client: l, effects: u } = Gr(s, n ?? Ca, c);
	return ct(t, () => l, [l]), /* @__PURE__ */ (0, H.jsx)(fr.Provider, {
		value: c,
		children: /* @__PURE__ */ (0, H.jsxs)(zn.Provider, {
			value: l,
			children: [
				/* @__PURE__ */ (0, H.jsx)(wa, { effects: Hn(s) }),
				u && /* @__PURE__ */ (0, H.jsx)(wa, { effects: u }),
				r
			]
		})
	});
}), Ea = (e) => {
	let t = Kr(), n = et(!1), r = n.current ? null : e(t);
	return B(() => n.current ? e(t) : r), () => (n.current = !0, e(t));
}, Da = Object.freeze({});
function Oa(e) {
	let t = N(3), { getItemState: n, children: r } = e, i = Ea(n), a;
	return t[0] !== r || t[1] !== i ? (a = r(i), t[0] = r, t[1] = i, t[2] = a) : a = t[2], ka(a);
}
var ka = (e) => {
	let t = typeof e == "object" && e && "type" in e ? e : null, n = t?.type, r = t?.key;
	return tt(() => t, [
		n,
		r,
		typeof t?.props == "object" && t.props != null && Object.entries(t.props).length === 0 ? Da : t?.props
	]) ?? e;
}, Aa = (e, t) => {
	let n = N(11), r = Kr(), i = it(t), a;
	n[0] === e ? a = n[1] : (a = Yn(e), n[0] = e, n[1] = a);
	let { scope: o, event: s } = a, c;
	n[2] !== r || n[3] !== i || n[4] !== s || n[5] !== o ? (c = () => r.on({
		scope: o,
		event: s
	}, i), n[2] = r, n[3] = i, n[4] = s, n[5] = o, n[6] = c) : c = n[6];
	let l;
	n[7] !== r || n[8] !== s || n[9] !== o ? (l = [
		r,
		o,
		s
	], n[7] = r, n[8] = s, n[9] = o, n[10] = l) : l = n[10], R(c, l);
}, ja = (e) => e._core?.RenderComponent, Ma = ({ runtime: e, aui: t, config: n, children: r }) => {
	"use no memo";
	let i = ja(e), a = vn({
		...n,
		threads: xa(e)
	});
	return /* @__PURE__ */ (0, H.jsxs)(Ta, {
		extends: t,
		config: a,
		children: [i && /* @__PURE__ */ (0, H.jsx)(i, {}), r]
	});
}, Na = ut((e) => {
	let t = N(5), { runtime: n, aui: r, config: i, children: a } = e, o = r === void 0 ? null : r, s;
	return t[0] !== o || t[1] !== a || t[2] !== i || t[3] !== n ? (s = /* @__PURE__ */ (0, H.jsx)(Ma, {
		runtime: n,
		aui: o,
		config: i,
		children: a
	}), t[0] = o, t[1] = a, t[2] = i, t[3] = n, t[4] = s) : s = t[4], s;
});
//#endregion
//#region node_modules/@assistant-ui/core/dist/utils/json/is-json.js
function Pa(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function Fa(e, t = 0) {
	return t > 100 ? !1 : e === null || typeof e == "string" || typeof e == "boolean" ? !0 : typeof e == "number" ? !Number.isNaN(e) && Number.isFinite(e) : Array.isArray(e) ? e.every((e) => Fa(e, t + 1)) : Pa(e) ? Object.entries(e).every(([e, n]) => typeof e == "string" && Fa(n, t + 1)) : !1;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/utils/json/is-json-equal.js
var Ia = 100, La = (e, t, n) => {
	if (e === t) return !0;
	if (n > Ia || e == null || t == null) return !1;
	if (Array.isArray(e)) return !Array.isArray(t) || e.length !== t.length ? !1 : e.every((e, r) => La(e, t[r], n + 1));
	if (Array.isArray(t) || !Pa(e) || !Pa(t)) return !1;
	let r = Object.keys(e), i = Object.keys(t);
	return r.length === i.length && r.every((r) => Object.hasOwn(t, r) && La(e[r], t[r], n + 1));
}, Ra = (e, t) => !Fa(e) || !Fa(t) ? !1 : La(e, t, 0), za = Symbol.for("aui.tool-response"), Ba = "<no result>", Va = class e {
	get [za]() {
		return !0;
	}
	artifact;
	result;
	isError;
	modelContent;
	messages;
	constructor(e) {
		e.artifact !== void 0 && (this.artifact = e.artifact);
		let t = e.result;
		this.result = t === void 0 ? Ba : t, this.isError = e.isError ?? !1, e.modelContent !== void 0 && (this.modelContent = e.modelContent), e.messages !== void 0 && (this.messages = e.messages);
	}
	static [Symbol.hasInstance](e) {
		return typeof e == "object" && !!e && za in e;
	}
	static toResponse(t) {
		return t instanceof e ? t : new e({ result: t === void 0 ? Ba : t });
	}
}, Ha = () => {
	let e, t, n = new Promise((n, r) => {
		e = n, t = r;
	});
	if (!e || !t) throw Error("Failed to create promise");
	return {
		promise: n,
		resolve: e,
		reject: t
	};
}, Ua = () => {
	let e = [], t = !1, n = !1, r = !1, i, a, o = 0, s, c, l = () => (a = void 0, c ??= Promise.all(e.splice(0).map(async (e) => {
		try {
			await e.reader.cancel().catch(() => void 0), await e.pipeTask;
		} finally {
			e.reader.releaseLock();
		}
	})).then(() => void 0), c), u = (e) => {
		n || r || (r = !0, console.error(e), l(), i.error(e), s?.reject(e), s = void 0);
	}, d = (a) => {
		a.promise ||= a.reader.read().then(({ done: c, value: l }) => {
			a.promise = void 0, !(n || r) && (c ? (e.splice(e.indexOf(a), 1), a.reader.releaseLock(), t && e.length === 0 && o === 0 && i.close()) : i.enqueue(l), s?.resolve(), s = void 0);
		}).catch(u);
	}, f = new ReadableStream({
		start(e) {
			i = e;
		},
		pull() {
			return s = Ha(), e.forEach((e) => {
				d(e);
			}), s.promise;
		},
		async cancel() {
			n = !0;
			let e = l();
			s?.resolve(), s = void 0, await e;
		}
	}), p = (c) => {
		if (e.length > 0 && (a = void 0), !a) {
			let c = [];
			a = c, o++, Promise.resolve().then(() => {
				if (o--, a === c && (a = void 0), !(n || r)) {
					for (let e of c) i.enqueue(e);
					t && e.length === 0 && o === 0 && i.close(), s?.resolve(), s = void 0;
				}
			}).catch(u);
		}
		a.push(c);
	};
	return {
		readable: f,
		isSealed() {
			return t;
		},
		isCancelled() {
			return n;
		},
		isErrored() {
			return r;
		},
		seal() {
			t || n || r || (t = !0, e.length === 0 && o === 0 && i.close());
		},
		addStream: (i, o) => {
			let s = o?.catch(() => void 0);
			if (n || r) {
				i.cancel().catch(() => void 0);
				return;
			}
			if (t) throw i.cancel().catch(() => void 0), Error("Cannot add streams after the run callback has settled.");
			a = void 0;
			let c = {
				reader: i.getReader(),
				pipeTask: s
			};
			e.push(c), d(c);
		},
		enqueue(e) {
			if (!(n || r)) {
				if (t) throw Error("Cannot add streams after the run callback has settled.");
				p(e);
			}
		}
	};
}, Wa = (e) => e instanceof TypeError, Ga = (e, t, n) => {
	try {
		e.enqueue(t);
	} catch (e) {
		if (!Wa(e)) throw e;
		n?.(e);
	}
}, Ka = (e) => {
	try {
		e.close();
	} catch (e) {
		if (!Wa(e)) throw e;
	}
}, qa = (e, t) => new ReadableStream({
	start(n) {
		return e.start?.(t(n));
	},
	pull(n) {
		return e.pull?.(t(n));
	},
	cancel(t) {
		return e.cancel?.(t);
	}
}), Ja = (e, t) => {
	let n;
	return [qa({
		start(e) {
			n = e;
		},
		cancel(e) {
			return t?.(n, e);
		}
	}, e), n];
}, Ya = class {
	_controller;
	_strict;
	_isClosed = !1;
	_warnedDropped = !1;
	constructor(e, t = {}) {
		this._controller = e, this._strict = t.strict ?? !0;
	}
	append(e) {
		let t = {
			type: "text-delta",
			path: [],
			textDelta: e
		};
		if (this._isClosed) {
			if (this._strict) throw TypeError("Cannot append to a closed TextStreamController");
			return Ga(this._controller, t, this._warnDroppedAfterClose), this;
		}
		return Ga(this._controller, t), this;
	}
	_warnDroppedAfterClose = (e) => {
		this._warnedDropped || (this._warnedDropped = !0, console.error(`Dropped text delta for closed stream: ${String(e)}`));
	};
	close() {
		this._isClosed || (this._isClosed = !0, Ga(this._controller, {
			type: "part-finish",
			path: []
		}), Ka(this._controller));
	}
}, Xa = (e, t = {}) => qa(e, (e) => new Ya(e, t)), Za = (e = {}) => Ja((t) => new Ya(t, e)), Qa = class {
	_isClosed = !1;
	_mergeTask;
	_controller;
	constructor(e, t = {}) {
		this._controller = e;
		let n = Xa({ start: (e) => {
			this._argsTextController = e;
		} }, t), r = !1;
		this._mergeTask = n.pipeTo(new WritableStream({ write: (e) => {
			switch (e.type) {
				case "text-delta":
					r = !0, Ga(this._controller, e);
					break;
				case "part-finish":
					r || Ga(this._controller, {
						type: "text-delta",
						textDelta: "{}",
						path: []
					}), Ga(this._controller, {
						type: "tool-call-args-text-finish",
						path: []
					});
					break;
				default: throw Error(`Unexpected chunk type: ${e.type}`);
			}
		} }));
	}
	get argsText() {
		return this._argsTextController;
	}
	_argsTextController;
	async setResponse(e) {
		if (this._isClosed) return;
		let t = e.result;
		Ga(this._controller, {
			type: "result",
			path: [],
			...e.artifact === void 0 ? {} : { artifact: e.artifact },
			result: t === void 0 ? Ba : t,
			isError: e.isError ?? !1,
			...e.modelContent === void 0 ? {} : { modelContent: e.modelContent },
			...e.messages === void 0 ? {} : { messages: e.messages }
		}), await this.close();
	}
	async close() {
		this._isClosed || (this._isClosed = !0, this._argsTextController.close(), await this._mergeTask, Ga(this._controller, {
			type: "part-finish",
			path: []
		}), Ka(this._controller));
	}
}, $a = (e = {}) => Ja((t) => new Qa(t, e)), eo = class {
	value = -1;
	up() {
		return ++this.value;
	}
}, to = class extends TransformStream {
	constructor(e) {
		super({ transform(t, n) {
			n.enqueue({
				...t,
				path: [e, ...t.path]
			});
		} });
	}
};
TransformStream;
var no = class extends TransformStream {
	constructor(e) {
		let t = new eo(), n = /* @__PURE__ */ new Map();
		super({ transform(r, i) {
			r.type === "part-start" && r.path.length === 0 && n.set(t.up(), e.up());
			let [a, ...o] = r.path;
			if (a === void 0) {
				i.enqueue(r);
				return;
			}
			let s = n.get(a);
			if (s === void 0) throw Error("Path not found");
			i.enqueue({
				...r,
				path: [s, ...o]
			});
		} });
	}
}, ro = (e, t = 21) => (n = t) => {
	let r = "", i = n | 0;
	for (; i-- > 0;) r += e[Math.random() * e.length | 0];
	return r;
}, io = ro("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 7), ao = class e {
	_state;
	_parentId;
	constructor(e, t = {}) {
		this._state = e || {
			strict: t.strict ?? !0,
			merger: Ua(),
			contentCounter: new eo()
		};
	}
	get __internal_isClosed() {
		return this._state.merger.isSealed() || this._state.merger.isCancelled() || this._state.merger.isErrored();
	}
	get __internal_isCancelled() {
		return this._state.merger.isCancelled();
	}
	__internal_getReadable() {
		return this._state.merger.readable;
	}
	__internal_subscribeToClose(e) {
		this._state.closeSubscriber = e;
	}
	_addTransformedStream(e, t) {
		if (e.locked) throw TypeError("Cannot merge a stream that is already locked to a reader.");
		let n = e.pipeTo(t.writable).catch(async (e) => {
			throw await t.writable.abort(e).catch(() => void 0), e;
		});
		this._state.merger.addStream(t.readable, n);
	}
	_addPart(e, t) {
		this._state.append && (this._state.append.controller.close(), this._state.append = void 0), this.enqueue({
			type: "part-start",
			part: e,
			path: []
		}), this._addTransformedStream(t, new to(this._state.contentCounter.value));
	}
	merge(e) {
		this._addTransformedStream(e, new no(this._state.contentCounter));
	}
	appendText(e) {
		(this._state.append?.kind !== "text" || this._state.append.parentId !== this._parentId) && (this._state.append = {
			kind: "text",
			parentId: this._parentId,
			controller: this.addTextPart()
		}), this._state.append.controller.append(e);
	}
	appendReasoning(e, t) {
		(t !== void 0 || this._state.append?.kind !== "reasoning" || this._state.append.parentId !== this._parentId) && (this._state.append = {
			kind: "reasoning",
			parentId: this._parentId,
			controller: this.addReasoningPart(t)
		}), (t === void 0 || e.length !== 0) && this._state.append.controller.append(e);
	}
	addTextPart() {
		let [e, t] = Za({ strict: this._state.strict });
		return this._addPart(this._withParentIdOption({ type: "text" }), e), t;
	}
	addReasoningPart(e) {
		let [t, n] = Za({ strict: this._state.strict });
		return this._addPart(this._withParentIdOption({
			type: "reasoning",
			...e
		}), t), n;
	}
	addToolCallPart(e) {
		let t = typeof e == "string" ? { toolName: e } : e, n = t.toolName, r = t.toolCallId ?? io(), [i, a] = $a({ strict: this._state.strict });
		return this._addPart({
			type: "tool-call",
			toolName: n,
			toolCallId: r,
			...this._parentId && { parentId: this._parentId }
		}, i), t.argsText !== void 0 && (a.argsText.append(t.argsText), a.argsText.close()), t.args !== void 0 && (a.argsText.append(JSON.stringify(t.args)), a.argsText.close()), t.response !== void 0 && a.setResponse(t.response), a;
	}
	_finishedPartStream() {
		return new ReadableStream({ start(e) {
			e.enqueue({
				type: "part-finish",
				path: []
			}), e.close();
		} });
	}
	_withParentIdOption(e) {
		return this._parentId ? {
			...e,
			parentId: this._parentId
		} : e;
	}
	appendSource(e) {
		this._addPart(this._withParentIdOption(e), this._finishedPartStream());
	}
	appendFile(e) {
		this._addPart(this._withParentIdOption(e), this._finishedPartStream());
	}
	appendData(e) {
		this._addPart(this._withParentIdOption(e), this._finishedPartStream());
	}
	enqueue(e) {
		this._state.merger.enqueue(e), e.type === "part-start" && e.path.length === 0 && this._state.contentCounter.up();
	}
	withParentId(t) {
		let n = new e(this._state);
		return n._parentId = t, n;
	}
	close() {
		this._state.append?.controller?.close(), this._state.merger.seal(), this._state.closeSubscriber?.();
	}
};
function oo(e, t = {}) {
	let n = new ao(void 0, t);
	return (async () => {
		try {
			await e(n);
		} catch (e) {
			n.__internal_isClosed ? n.__internal_isCancelled || console.error(e) : n.enqueue({
				type: "error",
				path: [],
				error: String(e)
			});
		} finally {
			n.__internal_isClosed || n.close();
		}
	})(), n.__internal_getReadable();
}
function so(e = {}) {
	let { resolve: t, promise: n } = Ha(), r;
	return [oo((e) => (r = e, r.__internal_subscribeToClose(t), n), e), r];
}
//#endregion
//#region node_modules/assistant-stream/dist/core/utils/stream/PipeableTransformStream.js
var co = class extends TransformStream {
	constructor(e) {
		super();
		let t = e(super.readable);
		Object.defineProperty(this, "readable", {
			value: t,
			writable: !1
		});
	}
}, lo = /* @__PURE__ */ o(((e, t) => {
	var n = typeof Buffer < "u", r = /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/, i = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
	function a(e, t, a) {
		a == null && typeof t == "object" && t && (a = t, t = void 0), n && Buffer.isBuffer(e) && (e = e.toString()), e && e.charCodeAt(0) === 65279 && (e = e.slice(1));
		let s = JSON.parse(e, t);
		if (typeof s != "object" || !s) return s;
		let c = a && a.protoAction || "error", l = a && a.constructorAction || "error";
		if (c === "ignore" && l === "ignore") return s;
		if (c !== "ignore" && l !== "ignore") {
			if (r.test(e) === !1 && i.test(e) === !1) return s;
		} else if (c !== "ignore" && l === "ignore") {
			if (r.test(e) === !1) return s;
		} else if (i.test(e) === !1) return s;
		return o(s, {
			protoAction: c,
			constructorAction: l,
			safe: a && a.safe
		});
	}
	function o(e, { protoAction: t = "error", constructorAction: n = "error", safe: r } = {}) {
		let i = [e];
		for (; i.length;) {
			let e = i;
			i = [];
			for (let a of e) {
				if (t !== "ignore" && Object.prototype.hasOwnProperty.call(a, "__proto__")) {
					if (r === !0) return null;
					if (t === "error") throw SyntaxError("Object contains forbidden prototype property");
					delete a.__proto__;
				}
				if (n !== "ignore" && Object.prototype.hasOwnProperty.call(a, "constructor") && a.constructor !== null && typeof a.constructor == "object" && Object.prototype.hasOwnProperty.call(a.constructor, "prototype")) {
					if (r === !0) return null;
					if (n === "error") throw SyntaxError("Object contains forbidden prototype property");
					delete a.constructor;
				}
				for (let e in a) {
					let t = a[e];
					t && typeof t == "object" && i.push(t);
				}
			}
		}
		return e;
	}
	function s(e, t, n) {
		let { stackTraceLimit: r } = Error;
		Error.stackTraceLimit = 0;
		try {
			return a(e, t, n);
		} finally {
			Error.stackTraceLimit = r;
		}
	}
	function c(e, t) {
		let { stackTraceLimit: n } = Error;
		Error.stackTraceLimit = 0;
		try {
			return a(e, t, { safe: !0 });
		} catch {
			return;
		} finally {
			Error.stackTraceLimit = n;
		}
	}
	t.exports = s, t.exports.default = s, t.exports.parse = s, t.exports.safeParse = c, t.exports.scan = o;
})), uo = class extends TransformStream {
	constructor() {
		let e = [];
		super({ transform(t, n) {
			if (t.type === "part-start") {
				if (t.path.length !== 0) {
					n.error(/* @__PURE__ */ Error("Nested parts are not supported"));
					return;
				}
				e.push(t.part), n.enqueue(t);
				return;
			}
			if (t.type === "text-delta" || t.type === "result" || t.type === "part-finish" || t.type === "tool-call-args-text-finish") {
				if (t.path.length !== 1) {
					n.error(/* @__PURE__ */ Error(`${t.type} chunks must have a path of length 1`));
					return;
				}
				let r = t.path[0];
				if (r < 0 || r >= e.length) {
					n.error(/* @__PURE__ */ Error(`Invalid path index: ${r}`));
					return;
				}
				let i = e[r];
				n.enqueue({
					...t,
					meta: i
				});
				return;
			}
			n.enqueue(t);
		} });
	}
}, fo = /[0-9a-fA-F]/;
function po(e) {
	let t = ["ROOT"], n = -1, r = null, i = 0, a = [], o;
	function s() {
		o !== void 0 && (a.push(JSON.parse(`"${o}"`)), o = void 0);
	}
	function c(e, i, a) {
		switch (e) {
			case "\"":
				n = i, t.pop(), t.push(a), t.push("INSIDE_STRING"), s();
				break;
			case "f":
			case "t":
			case "n":
				n = i, r = i, t.pop(), t.push(a), t.push("INSIDE_LITERAL");
				break;
			case "-":
				t.pop(), t.push(a), t.push("INSIDE_NUMBER"), s();
				break;
			case "0":
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9":
				n = i, t.pop(), t.push(a), t.push("INSIDE_NUMBER"), s();
				break;
			case "{":
				n = i, t.pop(), t.push(a), t.push("INSIDE_OBJECT_START"), s();
				break;
			case "[": n = i, t.pop(), t.push(a), t.push("INSIDE_ARRAY_START"), s();
		}
	}
	function l(e, r) {
		switch (e) {
			case ",":
				t.pop(), t.push("INSIDE_OBJECT_AFTER_COMMA");
				break;
			case "}": n = r, t.pop(), o = a.pop();
		}
	}
	function u(e, r) {
		switch (e) {
			case ",":
				t.pop(), t.push("INSIDE_ARRAY_AFTER_COMMA"), o = (Number(o) + 1).toString();
				break;
			case "]": n = r, t.pop(), o = a.pop();
		}
	}
	for (let s = 0; s < e.length; s++) {
		let d = e[s];
		switch (t[t.length - 1]) {
			case "ROOT":
				c(d, s, "FINISH");
				break;
			case "INSIDE_OBJECT_START":
				switch (d) {
					case "\"":
						t.pop(), t.push("INSIDE_OBJECT_KEY"), o = "";
						break;
					case "}": n = s, t.pop(), o = a.pop();
				}
				break;
			case "INSIDE_OBJECT_AFTER_COMMA":
				d === "\"" && (t.pop(), t.push("INSIDE_OBJECT_KEY"), o = "");
				break;
			case "INSIDE_OBJECT_KEY":
				switch (d) {
					case "\"":
						t.pop(), t.push("INSIDE_OBJECT_AFTER_KEY");
						break;
					case "\\":
						t.push("INSIDE_STRING_ESCAPE"), o += d;
						break;
					default: o += d;
				}
				break;
			case "INSIDE_OBJECT_AFTER_KEY":
				d === ":" && (t.pop(), t.push("INSIDE_OBJECT_BEFORE_VALUE"));
				break;
			case "INSIDE_OBJECT_BEFORE_VALUE":
				c(d, s, "INSIDE_OBJECT_AFTER_VALUE");
				break;
			case "INSIDE_OBJECT_AFTER_VALUE":
				l(d, s);
				break;
			case "INSIDE_STRING":
				switch (d) {
					case "\"":
						t.pop(), n = s, o = a.pop();
						break;
					case "\\":
						t.push("INSIDE_STRING_ESCAPE");
						break;
					default: n = s;
				}
				break;
			case "INSIDE_ARRAY_START":
				switch (d) {
					case "]":
						n = s, t.pop(), o = a.pop();
						break;
					default: o = "0", c(d, s, "INSIDE_ARRAY_AFTER_VALUE");
				}
				break;
			case "INSIDE_ARRAY_AFTER_VALUE":
				switch (d) {
					case ",":
						t.pop(), t.push("INSIDE_ARRAY_AFTER_COMMA"), o = (Number(o) + 1).toString();
						break;
					case "]":
						n = s, t.pop(), o = a.pop();
						break;
					default: n = s;
				}
				break;
			case "INSIDE_ARRAY_AFTER_COMMA":
				c(d, s, "INSIDE_ARRAY_AFTER_VALUE");
				break;
			case "INSIDE_STRING_ESCAPE": {
				t.pop();
				let e = t[t.length - 1];
				d === "u" ? (t.push("INSIDE_STRING_UNICODE_ESCAPE"), i = 0) : e === "INSIDE_STRING" && (n = s), e === "INSIDE_OBJECT_KEY" && (o += d);
				break;
			}
			case "INSIDE_STRING_UNICODE_ESCAPE": {
				let e = t[t.length - 2];
				if (!fo.test(d)) {
					t.pop(), s--;
					break;
				}
				i++, i === 4 && (t.pop(), e === "INSIDE_STRING" && (n = s)), e === "INSIDE_OBJECT_KEY" && (o += d);
				break;
			}
			case "INSIDE_NUMBER":
				switch (d) {
					case "0":
					case "1":
					case "2":
					case "3":
					case "4":
					case "5":
					case "6":
					case "7":
					case "8":
					case "9":
						n = s;
						break;
					case "e":
					case "E":
					case "-":
					case "+":
					case ".": break;
					case ",":
						t.pop(), o = a.pop(), t[t.length - 1] === "INSIDE_ARRAY_AFTER_VALUE" && u(d, s), t[t.length - 1] === "INSIDE_OBJECT_AFTER_VALUE" && l(d, s);
						break;
					case "}":
						t.pop(), o = a.pop(), t[t.length - 1] === "INSIDE_OBJECT_AFTER_VALUE" && l(d, s);
						break;
					case "]":
						t.pop(), o = a.pop(), t[t.length - 1] === "INSIDE_ARRAY_AFTER_VALUE" && u(d, s);
						break;
					default: t.pop(), o = a.pop();
				}
				break;
			case "INSIDE_LITERAL": {
				let i = e.substring(r, s + 1);
				!"false".startsWith(i) && !"true".startsWith(i) && !"null".startsWith(i) ? (t.pop(), t[t.length - 1] === "INSIDE_OBJECT_AFTER_VALUE" ? l(d, s) : t[t.length - 1] === "INSIDE_ARRAY_AFTER_VALUE" && u(d, s)) : n = s;
				break;
			}
		}
	}
	let d = e.slice(0, n + 1);
	for (let n = t.length - 1; n >= 0; n--) switch (t[n]) {
		case "INSIDE_STRING":
			d += "\"";
			break;
		case "INSIDE_OBJECT_KEY":
		case "INSIDE_OBJECT_AFTER_KEY":
		case "INSIDE_OBJECT_AFTER_COMMA":
		case "INSIDE_OBJECT_START":
		case "INSIDE_OBJECT_BEFORE_VALUE":
		case "INSIDE_OBJECT_AFTER_VALUE":
			d += "}";
			break;
		case "INSIDE_ARRAY_START":
		case "INSIDE_ARRAY_AFTER_COMMA":
		case "INSIDE_ARRAY_AFTER_VALUE":
			d += "]";
			break;
		case "INSIDE_LITERAL": {
			let t = e.substring(r, e.length);
			"true".startsWith(t) ? d += "true".slice(t.length) : "false".startsWith(t) ? d += "false".slice(t.length) : "null".startsWith(t) && (d += "null".slice(t.length));
		}
	}
	return [d, a];
}
//#endregion
//#region node_modules/assistant-stream/dist/utils/json/parse-partial-json-object.js
var mo = /* @__PURE__ */ l(lo(), 1), ho = Symbol("aui.parse-partial-json-object.meta"), go = (e) => e?.[ho], _o = (e) => {
	if (e.length === 0) return { [ho]: {
		state: "partial",
		partialPath: []
	} };
	try {
		let t = mo.default.parse(e);
		if (typeof t != "object" || !t) throw Error("argsText is expected to be an object");
		return t[ho] = {
			state: "complete",
			partialPath: []
		}, t;
	} catch {
		try {
			let [t, n] = po(e), r = mo.default.parse(t);
			if (typeof r != "object" || !r) throw Error("argsText is expected to be an object");
			return r[ho] = {
				state: "partial",
				partialPath: n
			}, r;
		} catch {
			return;
		}
	}
}, vo = (e, t, n) => {
	if (typeof e != "object" || !e) return t.state;
	if (t.state === "complete") return "complete";
	if (n.length === 0) return t.state;
	let [r, ...i] = n;
	if (!Object.hasOwn(e, r)) return "partial";
	let [a, ...o] = t.partialPath;
	if (r !== a) return "complete";
	let s = e[r];
	return vo(s, {
		state: "partial",
		partialPath: o
	}, i);
}, yo = (e, t) => {
	let n = go(e);
	if (!n) throw Error("unable to determine object state");
	return vo(e, n, t.map(String));
};
//#endregion
//#region node_modules/assistant-stream/dist/utils/AsyncIterableStream.js
async function* bo() {
	let e = this.getReader(), t = !0;
	try {
		for (;;) {
			let n;
			try {
				n = await e.read();
			} catch (e) {
				throw t = !1, e;
			}
			if (n.done) {
				t = !1;
				break;
			}
			let { value: r } = n;
			yield r;
		}
	} finally {
		try {
			t && await e.cancel();
		} finally {
			e.releaseLock();
		}
	}
}
function xo(e) {
	return e[Symbol.asyncIterator] ??= bo, e;
}
//#endregion
//#region node_modules/assistant-stream/dist/core/utils/withPromiseOrValue.js
function So(e, t, n) {
	try {
		let r = e();
		if (typeof r == "object" && r && "then" in r) return r.then(t, n);
		t(r);
	} catch (e) {
		n(e);
	}
}
//#endregion
//#region node_modules/assistant-stream/dist/core/tool/ToolCallReader.js
function Co(e, t) {
	let n = e;
	for (let e of t) {
		if (n == null || !Object.hasOwn(n, e)) return;
		n = n[e];
	}
	return n;
}
var wo = class {
	resolve;
	reject;
	disposed = !1;
	fieldPath;
	get isDisposed() {
		return this.disposed;
	}
	constructor(e, t, n) {
		this.resolve = e, this.reject = t, this.fieldPath = n;
	}
	update(e) {
		if (!this.disposed) try {
			if (yo(e, this.fieldPath) === "complete") {
				let t = Co(e, this.fieldPath);
				t !== void 0 && (this.resolve(t), this.dispose());
			}
		} catch (e) {
			this.reject(e), this.dispose();
		}
	}
	end(e) {
		if (!this.disposed) try {
			let t = Co(e, this.fieldPath);
			this.resolve(t);
		} catch (e) {
			this.reject(e);
		} finally {
			this.dispose();
		}
	}
	dispose() {
		this.disposed = !0;
	}
}, To = class {
	controller;
	disposed = !1;
	fieldPath;
	get isDisposed() {
		return this.disposed;
	}
	constructor(e, t) {
		this.controller = e, this.fieldPath = t;
	}
	update(e) {
		if (!this.disposed) try {
			let t = Co(e, this.fieldPath);
			t !== void 0 && this.controller.enqueue(t), yo(e, this.fieldPath) === "complete" && (this.controller.close(), this.dispose());
		} catch (e) {
			this.controller.error(e), this.dispose();
		}
	}
	end() {
		this.disposed || (this.controller.close(), this.dispose());
	}
	dispose() {
		this.disposed = !0;
	}
}, Eo = class {
	controller;
	disposed = !1;
	fieldPath;
	lastValue = void 0;
	get isDisposed() {
		return this.disposed;
	}
	constructor(e, t) {
		this.controller = e, this.fieldPath = t;
	}
	update(e) {
		if (!this.disposed) try {
			let t = Co(e, this.fieldPath);
			if (t !== void 0 && typeof t == "string") {
				let e = t.substring(this.lastValue?.length || 0);
				this.lastValue = t, this.controller.enqueue(e);
			}
			yo(e, this.fieldPath) === "complete" && (this.controller.close(), this.dispose());
		} catch (e) {
			this.controller.error(e), this.dispose();
		}
	}
	end() {
		this.disposed || (this.controller.close(), this.dispose());
	}
	dispose() {
		this.disposed = !0;
	}
}, Do = class {
	controller;
	disposed = !1;
	fieldPath;
	nextIndex = 0;
	get isDisposed() {
		return this.disposed;
	}
	constructor(e, t) {
		this.controller = e, this.fieldPath = t;
	}
	update(e) {
		if (!this.disposed) try {
			let t = Co(e, this.fieldPath);
			if (!Array.isArray(t)) return;
			for (; this.nextIndex < t.length && yo(e, [...this.fieldPath, this.nextIndex]) === "complete"; this.nextIndex++) this.controller.enqueue(t[this.nextIndex]);
			yo(e, this.fieldPath) === "complete" && (this.controller.close(), this.dispose());
		} catch (e) {
			this.controller.error(e), this.dispose();
		}
	}
	end() {
		this.disposed || (this.controller.close(), this.dispose());
	}
	dispose() {
		this.disposed = !0;
	}
}, Oo = class {
	argTextDeltas;
	handles = /* @__PURE__ */ new Set();
	accumulatedText = "";
	parsedTextLength = -1;
	args = void 0;
	finished = !1;
	constructor(e) {
		this.argTextDeltas = e, this.processStream();
	}
	async processStream() {
		try {
			let e = this.argTextDeltas.getReader();
			for (;;) {
				let { value: t, done: n } = await e.read();
				if (n) break;
				this.accumulatedText += t, this.handles.size !== 0 && this.parseCurrentArgs() && this.updateHandles();
			}
		} catch (e) {
			console.error("Error processing argument stream:", e);
		} finally {
			this.finished = !0;
			for (let e of this.handles) e.end(this.args);
			this.handles.clear();
		}
	}
	parseCurrentArgs() {
		if (this.parsedTextLength === this.accumulatedText.length) return !1;
		let e = _o(this.accumulatedText);
		return this.parsedTextLength = this.accumulatedText.length, e === void 0 ? (this.args ??= _o(""), !1) : (this.args = e, !0);
	}
	updateHandles() {
		for (let e of this.handles) e.update(this.args), e.isDisposed && this.handles.delete(e);
	}
	activateHandle(e) {
		if (this.parseCurrentArgs(), e.update(this.args), !e.isDisposed) {
			if (this.finished) {
				e.end(this.args);
				return;
			}
			this.handles.add(e);
		}
	}
	get(...e) {
		return new Promise((t, n) => {
			let r = new wo(t, n, e);
			this.activateHandle(r);
		});
	}
	streamValues(...e) {
		let t = e, n;
		return xo(new ReadableStream({
			start: (e) => {
				n = new To(e, t), this.activateHandle(n);
			},
			cancel: () => {
				n && (n.dispose(), this.handles.delete(n));
			}
		}));
	}
	streamText(...e) {
		let t = e, n;
		return xo(new ReadableStream({
			start: (e) => {
				n = new Eo(e, t), this.activateHandle(n);
			},
			cancel: () => {
				n && (n.dispose(), this.handles.delete(n));
			}
		}));
	}
	forEach(...e) {
		let t = e, n;
		return xo(new ReadableStream({
			start: (e) => {
				n = new Do(e, t), this.activateHandle(n);
			},
			cancel: () => {
				n && (n.dispose(), this.handles.delete(n));
			}
		}));
	}
}, ko = class {
	promise;
	constructor(e) {
		this.promise = e;
	}
	get() {
		return this.promise;
	}
}, Ao = class {
	args;
	response;
	writable;
	resolve;
	argsText = "";
	constructor() {
		let e = new TransformStream();
		this.writable = e.writable, this.args = new Oo(e.readable);
		let { promise: t, resolve: n } = Ha();
		this.resolve = n, this.response = new ko(t);
	}
	async appendArgsTextDelta(e) {
		let t = this.writable.getWriter();
		try {
			await t.write(e);
		} catch (e) {
			console.warn(e);
		} finally {
			t.releaseLock();
		}
		this.argsText += e;
	}
	async finishArgsText() {
		let e = this.writable.getWriter();
		try {
			await e.close();
		} catch (e) {
			console.warn(e);
		} finally {
			e.releaseLock();
		}
	}
	setResponse(e) {
		this.resolve(e);
	}
	result = { get: async () => (await this.response.get()).result };
}, jo = Symbol.for("assistant-stream.tool-execution-id"), Mo = (e, t, n, r, i) => {
	try {
		let a = t?.(n, r, i);
		Promise.resolve(a).catch((t) => {
			console.error(`[assistant-stream] ${e} callback threw an error`, t);
		});
	} catch (t) {
		console.error(`[assistant-stream] ${e} callback threw an error`, t);
	}
}, No = (e) => e.join(","), Po = (e, t) => {
	let n = { ...e };
	return Object.defineProperty(n, jo, {
		value: t,
		enumerable: !0
	}), n;
}, Fo = class extends co {
	constructor(e) {
		let t = e, n = /* @__PURE__ */ new Map(), r = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Set(), a = /* @__PURE__ */ new Map(), o = 0;
		super((e) => {
			let s = new TransformStream({
				async transform(e, s) {
					let c = a.get(No(e.path));
					switch ((e.type !== "part-finish" || e.meta.type !== "tool-call") && s.enqueue(c ? Po(e, c) : e), e.type) {
						case "part-start": {
							let n = o;
							if (o += 1, e.part.type === "tool-call") {
								let i = new Ao(), o = Symbol();
								a.set(String(n), o), r.set(o, i), t.streamCall({
									reader: i,
									toolCallId: e.part.toolCallId,
									toolName: e.part.toolName,
									executionId: o
								});
							}
							break;
						}
						case "text-delta":
							if (e.meta.type === "tool-call") {
								let t = a.get(No(e.path)), n = t ? r.get(t) : void 0;
								if (!n) throw Error("No controller found for tool call");
								await n.appendArgsTextDelta(e.textDelta);
							}
							break;
						case "result": {
							if (e.meta.type !== "tool-call") break;
							let t = a.get(No(e.path)), n = t ? r.get(t) : void 0;
							if (!n) throw Error("No controller found for tool call");
							n.setResponse(new Va({
								result: e.result,
								artifact: e.artifact,
								isError: e.isError,
								modelContent: e.modelContent,
								messages: e.messages
							})), i.add(t);
							break;
						}
						case "tool-call-args-text-finish": {
							if (e.meta.type !== "tool-call") break;
							let { toolCallId: o, toolName: c } = e.meta, l = a.get(No(e.path)), u = l ? r.get(l) : void 0;
							if (!u) throw Error("No controller found for tool call");
							if (await u.finishArgsText(), i.has(l)) break;
							let d = !1, f = So(() => {
								let e;
								try {
									e = mo.default.parse(u.argsText);
								} catch (e) {
									throw Error(`Function parameter parsing failed. ${JSON.stringify(e.message)}`);
								}
								let n = t.execute({
									toolCallId: o,
									toolName: c,
									args: e,
									executionId: l
								});
								return n !== void 0 && (d = !0, Mo("onExecutionStart", t.onExecutionStart, o, c, l)), n;
							}, (n) => {
								if (d && Mo("onExecutionEnd", t.onExecutionEnd, o, c, l), n === void 0) return;
								let r = new Va({
									artifact: n.artifact,
									result: n.result,
									isError: n.isError,
									messages: n.messages,
									modelContent: n.modelContent
								});
								u.setResponse(r), Ga(s, Po({
									type: "result",
									path: e.path,
									...r
								}, l));
							}, (n) => {
								d && Mo("onExecutionEnd", t.onExecutionEnd, o, c, l);
								let r = new Va({
									result: String(n),
									isError: !0
								});
								u.setResponse(r), Ga(s, Po({
									type: "result",
									path: e.path,
									...r
								}, l));
							});
							f && n.set(l, f);
							break;
						}
						case "part-finish": {
							if (e.meta.type !== "tool-call") break;
							let t = a.get(No(e.path)), o = t ? n.get(t) : void 0, c = () => {
								t && (n.delete(t), r.delete(t), i.delete(t), a.delete(No(e.path)));
							};
							o ? o.then(() => {
								c(), Ga(s, e);
							}) : (c(), s.enqueue(e));
						}
					}
				},
				async flush() {
					await Promise.all(n.values());
				}
			});
			return e.pipeThrough(new uo()).pipeThrough(s);
		});
	}
}, Io = Symbol.for("assistant-stream.tool-execution-id"), Lo = Symbol("assistant-stream.tool-aborted"), Ro = (e) => typeof e == "object" && !!e && "~standard" in e && e["~standard"].version === 1, zo = (e) => typeof e?.then == "function", Bo = async (e, t, n = !1) => {
	let r, i = new Promise((e) => {
		r = () => {
			n ? queueMicrotask(() => queueMicrotask(() => e(Lo))) : e(Lo);
		}, t.aborted ? r() : t.addEventListener("abort", r, { once: !0 });
	});
	try {
		return await Promise.race([e, i]);
	} finally {
		t.removeEventListener("abort", r);
	}
}, U = () => new Va({
	result: "Tool execution was cancelled.",
	isError: !0
});
function Vo(e, t, n, r) {
	let i = e?.[n.toolName];
	return i?.execute ? (async (e) => {
		if (t.aborted) return U();
		let a = e;
		if (Ro(i.parameters)) {
			let e = i.parameters["~standard"].validate(n.args), r = zo(e) ? await Bo(e, t) : e;
			if (r === Lo) return U();
			r.issues && (a = i.experimental_onSchemaValidationError ?? (() => {
				throw Error(`Function parameter validation failed. ${JSON.stringify(r.issues)}`);
			}));
		}
		if (t.aborted) return U();
		let o = await Bo((async () => {
			let e = {
				toolCallId: n.toolCallId,
				abortSignal: t,
				human: (e) => r(n.toolCallId, e, n.executionId),
				[Io]: n.executionId
			}, o = await a(n.args, e), s = Va.toResponse(o);
			if (i.toModelOutput && !s.isError && s.modelContent === void 0) try {
				let e = await i.toModelOutput({
					toolCallId: n.toolCallId,
					input: n.args,
					output: s.result
				});
				return new Va({
					result: s.result,
					artifact: s.artifact,
					isError: s.isError,
					messages: s.messages,
					modelContent: e
				});
			} catch (e) {
				console.warn(`[assistant-stream] tool "${n.toolName}" toModelOutput threw; falling back to default projection.`, e);
			}
			return s;
		})(), t, !0);
		return o === Lo ? U() : o;
	})(i.execute) : void 0;
}
function Ho(e, t, n, r, i) {
	let a = {
		toolCallId: r.toolCallId,
		abortSignal: t,
		human: (e) => i(r.toolCallId, e, r.executionId),
		[Io]: r.executionId
	};
	e?.[r.toolName]?.streamCall?.(n, a);
}
function Uo(e, t, n, r) {
	let i = typeof e == "function" ? e : () => e, a = typeof t == "function" ? t : () => t, o = r, s = n;
	return new Fo({
		execute: (e) => Vo(i(), a(), e, s),
		streamCall: ({ reader: e, ...t }) => Ho(i(), a(), e, t, s),
		onExecutionStart: o?.onExecutionStart,
		onExecutionEnd: o?.onExecutionEnd
	});
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/model-context/interactable-composer-metadata.js
function Wo(e) {
	let t = e.metadata;
	if (!t || typeof t != "object") return;
	let n = t.custom;
	if (!n || typeof n != "object") return;
	let r = n.interactables;
	return Array.isArray(r) ? r : void 0;
}
function Go(e) {
	return `update_${e.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
var Ko = (e) => {
	if (!Pa(e)) return;
	let t = e.id;
	return typeof t == "string" || typeof t == "number" ? t : void 0;
};
function qo(e, t, n) {
	let r = Array.isArray(t.set) ? [...t.set] : [...e];
	if (t.clear === !0 && (r = []), Array.isArray(t.remove) && t.remove.length > 0) {
		let e = new Set(t.remove);
		r = r.filter((t) => {
			let n = Ko(t);
			return n === void 0 ? !e.has(t) : !e.has(n);
		});
	}
	let i = t.update;
	if (Array.isArray(i) && i.length > 0) {
		let e = /* @__PURE__ */ new Map();
		for (let t of i) {
			let n = Ko(t);
			n !== void 0 && !Number.isNaN(n) && !e.has(n) && e.set(n, t);
		}
		r = r.map((t) => {
			let n = Ko(t);
			if (n === void 0 || !Pa(t)) return t;
			let r = e.get(n);
			return r ? {
				...t,
				...r
			} : t;
		});
	}
	if (Array.isArray(t.add) && t.add.length > 0) {
		let e = n ? t.add.map((e) => {
			if (!Pa(e) || e.id !== void 0) return e;
			let t = n();
			return t === void 0 ? e : {
				...e,
				id: t
			};
		}) : t.add;
		r = [...r, ...e];
	}
	return r;
}
function Jo(e, t, n) {
	if (!Pa(e) || !Pa(t)) return t;
	let r = Pa(n?.arrayBaseline) ? n.arrayBaseline : e, i = Object.entries(e);
	for (let [e, a] of Object.entries(t)) {
		let t = r[e];
		if (Array.isArray(t) && Pa(a)) {
			let r = n?.idFactory && (n.idKeyedFields === void 0 || n.idKeyedFields.has(e)) ? () => n.idFactory?.(e) : void 0;
			i.push([e, qo(t, a, r)]);
		} else i.push([e, a]);
	}
	return Object.fromEntries(i);
}
function Yo(e, t) {
	if (!Pa(e) || !Pa(t)) return;
	for (let n of Object.keys(e)) if (!Object.hasOwn(t, n)) return;
	let n = [];
	for (let [r, i] of Object.entries(t)) (!Object.hasOwn(e, r) || !Ra(e[r], i)) && n.push([r, i]);
	let r = n.length;
	if (r !== 0 && r !== Object.keys(t).length) return Object.fromEntries(n);
}
var Xo = (e) => {
	if (!e || typeof e != "object") return;
	let t = e;
	return t.type === "tool-call" ? t : void 0;
}, Zo = (e, t) => {
	if (!e.args || typeof e.args != "object") return !1;
	let n = Pa(e.result) ? e.result : void 0;
	if (n?.success === !1) return !1;
	if (typeof n?.id == "string") return n.id === t;
	let r = e.args.id;
	return r === t || r === void 0;
}, Qo = (e) => {
	let t = Pa(e) ? e.addedItemIds : void 0;
	if (!Pa(t)) return;
	let n = /* @__PURE__ */ new Map();
	for (let [e, r] of Object.entries(t)) {
		if (!Array.isArray(r)) continue;
		let t = r.filter((e) => typeof e == "string");
		t.length > 0 && n.set(e, t);
	}
	if (n.size !== 0) return (e) => n.get(e)?.shift();
}, $o = /* @__PURE__ */ new WeakMap();
function es(e, t, n) {
	let r = $o.get(e);
	r || (r = /* @__PURE__ */ new Map(), $o.set(e, r));
	let i = r.get(n);
	i || (i = /* @__PURE__ */ new Map(), r.set(n, i));
	let a = i.get(t);
	if (a) return a;
	let o = Go(n), s = [], c = () => s[s.length - 1];
	for (let r of e) {
		if (r.role === "user") {
			let e = Wo(r)?.find((e) => e.id === t);
			if (!e) continue;
			if (e.partial) {
				let t = c();
				t && s.push({
					state: Jo(t.state, e.state),
					origin: "user-edit"
				});
			} else s.push({
				state: e.state,
				origin: "user-edit"
			});
			continue;
		}
		if (r.role === "assistant") for (let e of r.content ?? []) {
			let r = Xo(e);
			if (r) {
				if (r.toolCallId === t && r.toolName === n) r.args && typeof r.args == "object" && s.push({
					state: r.args,
					origin: "create",
					toolCallId: t
				});
				else if (r.toolName === o && Zo(r, t)) {
					let e = c();
					if (e) {
						let { id: t, ...n } = r.args, i = Qo(r.result);
						s.push({
							state: i ? Jo(e.state, n, { idFactory: i }) : Jo(e.state, n),
							origin: "update",
							toolCallId: r.toolCallId
						});
					}
				}
			}
		}
	}
	return i.set(t, s), s;
}
function ts(e, t, n) {
	let r = es(e, t, n), i = r[r.length - 1];
	return i ? { state: i.state } : void 0;
}
function ns(e, t) {
	if (!e) return;
	let { interactables: n, ...r } = e, i = { ...r };
	if (Array.isArray(n)) {
		let e = [];
		for (let r of n) {
			let n = ts(t, r.id, r.name);
			if (!n) {
				e.push({
					id: r.id,
					name: r.name,
					state: r.state
				});
				continue;
			}
			if (Ra(r.state, n.state)) continue;
			let i = Yo(n.state, r.state);
			e.push(i ? {
				id: r.id,
				name: r.name,
				state: i,
				partial: !0
			} : {
				id: r.id,
				name: r.name,
				state: r.state
			});
		}
		e.length && (i.interactables = e);
	}
	return Object.keys(i).length ? i : void 0;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/runtimes/useRuntimeAdapters.js
var rs = ht(null), is = () => _t(rs), as = Symbol("innerMessage"), os = Symbol("innerMessages"), ss = [], cs = (e, t) => {
	as in e || (e[as] = t);
}, ls = (e) => {
	let t = "messages" in e ? e.messages : e, n = t[os] || t[as];
	return n ? Array.isArray(n) ? n : (t[os] = [n], t[os]) : ss;
}, us = "__external_store_fallback_", ds = ro("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 7);
//#endregion
//#region node_modules/@assistant-ui/core/dist/utils/data-url.js
function fs(e) {
	let t = e.match(/^data:([^;,]+)(?:;[^;,]+)*;base64,(.*)$/i);
	return t ? {
		mimeType: t[1].toLowerCase(),
		data: t[2]
	} : null;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/runtime/utils/thread-message-like.js
var ps = (e, t) => {
	if (e.startsWith("data-")) return {
		type: "data",
		name: e.substring(5),
		data: t
	};
}, ms = (e, t, n) => {
	let { role: r, id: i, createdAt: a, attachments: o, status: s, metadata: c } = e, l = {
		id: i ?? t,
		createdAt: a ?? /* @__PURE__ */ new Date()
	}, u = typeof e.content == "string" ? [{
		type: "text",
		text: e.content
	}] : e.content, d = ({ image: e, ...t }) => typeof e == "string" ? fs(e)?.mimeType.startsWith("image/") || /^(https:\/\/|blob:)/i.test(e) ? {
		...t,
		image: e
	} : (console.warn("Invalid image data format detected"), null) : null;
	if (r !== "user" && o?.length) throw Error("attachments are only supported for user messages");
	if (r !== "assistant" && s) throw Error("status is only supported for assistant messages");
	if (r !== "assistant" && c?.steps) throw Error("metadata.steps is only supported for assistant messages");
	switch (r) {
		case "assistant": return {
			...l,
			role: r,
			content: u.map((e) => {
				let t = e.type;
				switch (t) {
					case "text": return e.text?.trim() ? e : null;
					case "reasoning": return !e.text?.trim() && !e.unstable_summary?.trim() ? null : e;
					case "file":
					case "source": return e;
					case "image": return d(e);
					case "data": return e;
					case "generative-ui": return e;
					case "tool-call": {
						let { parentId: t, messages: n, ...r } = e, i = {
							...r,
							toolCallId: e.toolCallId || `tool-${ds()}`,
							...t !== void 0 && { parentId: t },
							...n !== void 0 && { messages: n }
						};
						return e.args ? {
							...i,
							args: e.args,
							argsText: e.argsText ?? JSON.stringify(e.args)
						} : {
							...i,
							args: _o(e.argsText ?? "") ?? {},
							argsText: e.argsText ?? ""
						};
					}
					default: {
						let n = ps(t, e.data);
						if (n) return n;
						throw Error(`Unsupported assistant message part type: ${t}`);
					}
				}
			}).filter((e) => !!e),
			status: s ?? n,
			metadata: {
				unstable_state: c?.unstable_state ?? null,
				unstable_annotations: c?.unstable_annotations ?? [],
				unstable_data: c?.unstable_data ?? [],
				custom: c?.custom ?? {},
				steps: c?.steps ?? [],
				...c?.timing && { timing: c.timing },
				...c?.submittedFeedback && { submittedFeedback: c.submittedFeedback },
				...c?.isOptimistic && { isOptimistic: !0 },
				...c?.modality && { modality: c.modality }
			}
		};
		case "user": return {
			...l,
			role: r,
			content: u.map((e) => {
				let t = e.type;
				switch (t) {
					case "text":
					case "image":
					case "audio":
					case "file":
					case "data": return e;
					default: {
						let n = ps(t, e.data);
						if (n) return n;
						throw Error(`Unsupported user message part type: ${t}`);
					}
				}
			}),
			attachments: (o ?? []).map((e) => ({
				...e,
				content: e.content.map((e) => ps(e.type, e.data) ?? e)
			})),
			metadata: {
				custom: c?.custom ?? {},
				...c?.isOptimistic && { isOptimistic: !0 },
				...c?.modality && { modality: c.modality }
			}
		};
		case "system":
			if (u.length !== 1 || u[0].type !== "text") throw Error("System messages must have exactly one text message part.");
			return {
				...l,
				role: r,
				content: u,
				metadata: { custom: c?.custom ?? {} }
			};
		default: throw Error(`Unknown message role: ${r}`);
	}
}, hs = (e) => e.type === "tool-call" && e.result === void 0, gs = (e) => {
	if (e.type !== "tool-call" || e.result !== void 0) return !1;
	let t = e.messages?.at(-1);
	return t?.role === "assistant" && t.status.type === "running";
}, _s = (e) => e.type !== "tool-call" || e.result !== void 0 ? !1 : e.interrupt != null || e.approval != null && e.approval.approved === void 0 && e.approval.resolution === void 0, vs = Symbol("autoStatus"), ys = Object.freeze(Object.assign({ type: "running" }, { [vs]: !0 })), bs = Object.freeze(Object.assign({
	type: "complete",
	reason: "unknown"
}, { [vs]: !0 })), xs = Object.freeze(Object.assign({
	type: "incomplete",
	reason: "cancelled"
}, { [vs]: !0 })), Ss = Object.freeze(Object.assign({
	type: "requires-action",
	reason: "tool-calls"
}, { [vs]: !0 })), Cs = Object.freeze(Object.assign({
	type: "requires-action",
	reason: "interrupt"
}, { [vs]: !0 })), ws = (e) => e[vs] === !0, Ts = (e, t, n, r, i, a, o) => e && i ? Object.assign({
	type: "incomplete",
	reason: "error",
	error: i
}, { [vs]: !0 }) : e && t ? ys : n ? Cs : o && !a ? ys : r ? Ss : a ? xs : bs, Es = (e) => Ts(!1, !1, typeof e != "string" && e.some(_s), typeof e != "string" && e.some(hs)), Ds = (e, t, n) => Ts(t, n, typeof e != "string" && e.some(_s), typeof e != "string" && e.some(hs), void 0, void 0, typeof e != "string" && e.some(gs)), Os = class {
	cache = /* @__PURE__ */ new WeakMap();
	convertMessages(e, t) {
		return e.map((e, n) => {
			let r = t(this.cache.get(e), e, n);
			return this.cache.set(e, r), r;
		});
	}
}, ks = (e, t) => {
	if (e.length !== t.length) return !1;
	for (let n = 0; n < e.length; n++) if (e[n] !== t[n]) return !1;
	return !0;
}, As = (e) => {
	let t = N(6), { index: n, children: r } = e, i = Kr(), a;
	t[0] === n ? a = t[1] : (a = vn({ attachment: $r({
		source: "message",
		query: {
			type: "index",
			index: n
		},
		get: (e) => e.message.attachment({ index: n })
	}) }), t[0] = n, t[1] = a);
	let o = a, s;
	return t[2] !== i || t[3] !== r || t[4] !== o ? (s = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: i,
		config: o,
		children: r
	}), t[2] = i, t[3] = r, t[4] = o, t[5] = s) : s = t[5], s;
}, js = (e) => {
	let t = N(6), { index: n, children: r } = e, i = Kr(), a;
	t[0] === n ? a = t[1] : (a = vn({
		message: $r({
			source: "thread",
			query: {
				type: "index",
				index: n
			},
			get: (e) => e.thread.message({ index: n })
		}),
		composer: $r({
			source: "message",
			query: {},
			get: (e) => e.thread.message({ index: n }).composer()
		})
	}), t[0] = n, t[1] = a);
	let o = a, s;
	return t[2] !== i || t[3] !== r || t[4] !== o ? (s = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: i,
		config: o,
		children: r
	}), t[2] = i, t[3] = r, t[4] = o, t[5] = s) : s = t[5], s;
}, Ms = (e) => {
	let t = N(6), { index: n, children: r } = e, i = Kr(), a;
	t[0] === n ? a = t[1] : (a = vn({ part: $r({
		source: "message",
		query: {
			type: "index",
			index: n
		},
		get: (e) => e.message.part({ index: n })
	}) }), t[0] = n, t[1] = a);
	let o = a, s;
	return t[2] !== i || t[3] !== r || t[4] !== o ? (s = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: i,
		config: o,
		children: r
	}), t[2] = i, t[3] = r, t[4] = o, t[5] = s) : s = t[5], s;
}, Ns = vt((e) => {
	let t = N(7), { text: n, isRunning: r } = e, i;
	t[0] === r ? i = t[1] : (i = r ? { type: "running" } : { type: "complete" }, t[0] = r, t[1] = i);
	let a;
	t[2] !== i || t[3] !== n ? (a = {
		type: "text",
		text: n,
		status: i
	}, t[2] = i, t[3] = n, t[4] = a) : a = t[4];
	let o = a, s;
	return t[5] === o ? s = t[6] : (s = {
		getState: () => o,
		addToolResult: Fs,
		resumeToolCall: Is,
		respondToToolApproval: Ls
	}, t[5] = o, t[6] = s), s;
}), Ps = (e) => {
	let t = N(7), { text: n, isRunning: r, children: i } = e, a = r !== void 0 && r, o = Kr(), s;
	t[0] !== a || t[1] !== n ? (s = vn({ part: Ns({
		text: n,
		isRunning: a
	}) }), t[0] = a, t[1] = n, t[2] = s) : s = t[2];
	let c = s, l;
	return t[3] !== o || t[4] !== i || t[5] !== c ? (l = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: o,
		config: c,
		children: i
	}), t[3] = o, t[4] = i, t[5] = c, t[6] = l) : l = t[6], l;
};
function Fs() {
	throw Error("Not supported");
}
function Is() {
	throw Error("Not supported");
}
function Ls() {
	throw Error("Not supported");
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/utils/getGroupStatus.js
var Rs = (e) => {
	for (let t of e) if (t?.status.type === "running") return $i;
	return e.at(-1)?.status ?? Qi;
}, zs = (e, t) => {
	let n = {
		running: 0,
		complete: 0,
		incomplete: 0,
		requiresAction: 0
	}, r = Qi, i = !1;
	for (let a of t) switch (r = e[a]?.status ?? Qi, r.type) {
		case "running":
			n.running++, i = !0;
			break;
		case "complete":
			n.complete++;
			break;
		case "incomplete":
			n.incomplete++;
			break;
		case "requires-action": n.requiresAction++;
	}
	return {
		status: i ? $i : r,
		counts: n
	};
}, Bs = vt((e) => {
	let t = N(11), { parts: n, getMessagePart: r } = e, [i, a] = Qe(!0), o;
	t[0] === n ? o = t[1] : (o = Rs(n), t[0] = n, t[1] = o);
	let s = o, c;
	t[2] !== i || t[3] !== n || t[4] !== s ? (c = {
		parts: n,
		collapsed: i,
		status: s
	}, t[2] = i, t[3] = n, t[4] = s, t[5] = c) : c = t[5];
	let l = c, u;
	t[6] === l ? u = t[7] : (u = () => l, t[6] = l, t[7] = u);
	let d;
	return t[8] !== r || t[9] !== u ? (d = {
		getState: u,
		setCollapsed: a,
		part: r
	}, t[8] = r, t[9] = u, t[10] = d) : d = t[10], d;
}), Vs = (e) => {
	let t = N(4), { startIndex: n, endIndex: r, children: i } = e, a = B(Hs).slice(n, r + 1), o = Kr(), s = vn({ chainOfThought: Bs({
		parts: a,
		getMessagePart: (e) => {
			let { index: t } = e;
			if (t < 0 || t >= a.length) throw Error(`ChainOfThought part index ${t} is out of bounds (0..${a.length - 1})`);
			return o.message.part({ index: n + t });
		}
	}) }), c;
	return t[0] !== i || t[1] !== s || t[2] !== o ? (c = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: o,
		config: s,
		children: i
	}), t[0] = i, t[1] = s, t[2] = o, t[3] = c) : c = t[3], c;
};
function Hs(e) {
	return e.message.parts;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/providers/SuggestionByIndexProvider.js
var Us = (e) => {
	let t = N(6), { index: n, children: r } = e, i = Kr(), a;
	t[0] === n ? a = t[1] : (a = vn({ suggestion: $r({
		source: "suggestions",
		query: { index: n },
		get: (e) => e.suggestions.suggestion({ index: n })
	}) }), t[0] = n, t[1] = a);
	let o = a, s;
	return t[2] !== i || t[3] !== r || t[4] !== o ? (s = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: i,
		config: o,
		children: r
	}), t[2] = i, t[3] = r, t[4] = o, t[5] = s) : s = t[5], s;
}, Ws = Symbol.for("assistant-ui.message-not-sent"), Gs = (e) => typeof e == "object" && !!e && Ws in e, Ks = class {
	get path() {
		return this._core.path;
	}
	_core;
	constructor(e) {
		this._core = e, this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.getState = this.getState.bind(this), this.remove = this.remove.bind(this), this.subscribe = this.subscribe.bind(this);
	}
	getState() {
		return this._core.getState();
	}
	subscribe(e) {
		return this._core.subscribe(e);
	}
}, qs = class extends Ks {
	_composerApi;
	constructor(e, t) {
		super(e), this._composerApi = t;
	}
	remove() {
		let e = this._composerApi.getState();
		if (!e) throw Error("Composer is not available");
		return e.removeAttachment(this.getState().id);
	}
}, Js = class extends qs {
	get source() {
		return "thread-composer";
	}
}, Ys = class extends qs {
	get source() {
		return "edit-composer";
	}
}, Xs = class extends Ks {
	get source() {
		return "message";
	}
	remove() {
		throw Error("Message attachments cannot be removed");
	}
}, Zs = Object.freeze([]), Qs = Object.freeze({}), $s = (e) => Object.freeze({
	type: "thread",
	isEditing: e?.isEditing ?? !1,
	canCancel: e?.canCancel ?? !1,
	canSend: e?.canSend ?? !1,
	isEmpty: e?.isEmpty ?? !0,
	attachments: e?.attachments ?? Zs,
	text: e?.text ?? "",
	role: e?.role ?? "user",
	runConfig: e?.runConfig ?? Qs,
	attachmentAccept: e?.attachmentAccept ?? "",
	dictation: e?.dictation,
	quote: e?.quote,
	queue: e?.queue ?? Zs,
	value: e?.text ?? ""
}), ec = (e) => Object.freeze({
	type: "edit",
	isEditing: e?.isEditing ?? !1,
	canCancel: e?.canCancel ?? !1,
	canSend: e?.canSend ?? !1,
	isEmpty: e?.isEmpty ?? !0,
	text: e?.text ?? "",
	role: e?.role ?? "user",
	attachments: e?.attachments ?? Zs,
	runConfig: e?.runConfig ?? Qs,
	attachmentAccept: e?.attachmentAccept ?? "",
	dictation: e?.dictation,
	quote: e?.quote,
	queue: e?.queue ?? Zs,
	parentId: e?.parentId ?? null,
	sourceId: e?.sourceId ?? null,
	value: e?.text ?? ""
}), tc = class {
	get path() {
		return this._core.path;
	}
	_core;
	constructor(e) {
		this._core = e;
	}
	__internal_bindMethods() {
		this.setText = this.setText.bind(this), this.setRunConfig = this.setRunConfig.bind(this), this.getState = this.getState.bind(this), this.subscribe = this.subscribe.bind(this), this.addAttachment = this.addAttachment.bind(this), this.reset = this.reset.bind(this), this.clearAttachments = this.clearAttachments.bind(this), this.send = this.send.bind(this), this.cancel = this.cancel.bind(this), this.steerQueueItem = this.steerQueueItem.bind(this), this.moveQueueItem = this.moveQueueItem.bind(this), this.removeQueueItem = this.removeQueueItem.bind(this), this.setRole = this.setRole.bind(this), this.getAttachmentByIndex = this.getAttachmentByIndex.bind(this), this.startDictation = this.startDictation.bind(this), this.stopDictation = this.stopDictation.bind(this), this.setQuote = this.setQuote.bind(this), this.unstable_on = this.unstable_on.bind(this);
	}
	setText(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		t.setText(e);
	}
	setRunConfig(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		t.setRunConfig(e);
	}
	addAttachment(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		return t.addAttachment(e);
	}
	reset() {
		let e = this._core.getState();
		if (!e) throw Error("Composer is not available");
		return e.reset();
	}
	clearAttachments() {
		let e = this._core.getState();
		if (!e) throw Error("Composer is not available");
		return e.clearAttachments();
	}
	send(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		t.send(e);
	}
	cancel() {
		let e = this._core.getState();
		if (!e) throw Error("Composer is not available");
		e.cancel();
	}
	steerQueueItem(e) {
		this.moveQueueItem(e, {
			lane: "steer",
			insertAfter: null
		});
	}
	moveQueueItem(e, t) {
		let n = this._core.getState();
		if (!n) throw Error("Composer is not available");
		n.moveQueueItem(e, t);
	}
	removeQueueItem(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		t.removeQueueItem(e);
	}
	setRole(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		t.setRole(e);
	}
	startDictation() {
		let e = this._core.getState();
		if (!e) throw Error("Composer is not available");
		e.startDictation();
	}
	stopDictation() {
		let e = this._core.getState();
		if (!e) throw Error("Composer is not available");
		e.stopDictation();
	}
	setQuote(e) {
		let t = this._core.getState();
		if (!t) throw Error("Composer is not available");
		t.setQuote(e);
	}
	subscribe(e) {
		return this._core.subscribe(e);
	}
	_eventSubscriptionSubjects = /* @__PURE__ */ new Map();
	unstable_on(e, t) {
		let n = this._eventSubscriptionSubjects.get(e);
		return n || (n = new _i({
			event: e,
			binding: this._core
		}), this._eventSubscriptionSubjects.set(e, n)), n.subscribe(t);
	}
}, nc = class extends tc {
	get path() {
		return this._core.path;
	}
	get type() {
		return "thread";
	}
	_getState;
	constructor(e) {
		let t = new hi({
			path: e.path,
			getState: () => $s(e.getState()),
			subscribe: (t) => e.subscribe(t)
		});
		super({
			path: e.path,
			getState: () => e.getState(),
			subscribe: (e) => t.subscribe(e)
		}), this._getState = t.getState.bind(t), this.__internal_bindMethods();
	}
	getState() {
		return this._getState();
	}
	getAttachmentByIndex(e) {
		return new Js(new mi({
			path: {
				...this.path,
				attachmentSource: "thread-composer",
				attachmentSelector: {
					type: "index",
					index: e
				},
				ref: `${this.path.ref}.attachments[${e}]`
			},
			getState: () => {
				let t = this.getState().attachments[e];
				return t ? {
					...t,
					source: "thread-composer"
				} : ci;
			},
			subscribe: (e) => this._core.subscribe(e)
		}), this._core);
	}
}, rc = class extends tc {
	get path() {
		return this._core.path;
	}
	get type() {
		return "edit";
	}
	_getState;
	_beginEdit;
	constructor(e, t) {
		let n = new hi({
			path: e.path,
			getState: () => ec(e.getState()),
			subscribe: (t) => e.subscribe(t)
		});
		super({
			path: e.path,
			getState: () => e.getState(),
			subscribe: (e) => n.subscribe(e)
		}), this._beginEdit = t, this._getState = n.getState.bind(n), this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		super.__internal_bindMethods(), this.beginEdit = this.beginEdit.bind(this);
	}
	getState() {
		return this._getState();
	}
	beginEdit() {
		this._beginEdit();
	}
	getAttachmentByIndex(e) {
		return new Ys(new mi({
			path: {
				...this.path,
				attachmentSource: "edit-composer",
				attachmentSelector: {
					type: "index",
					index: e
				},
				ref: `${this.path.ref}.attachments[${e}]`
			},
			getState: () => {
				let t = this.getState().attachments[e];
				return t ? {
					...t,
					source: "edit-composer"
				} : ci;
			},
			subscribe: (e) => this._core.subscribe(e)
		}), this._core);
	}
}, ic = (e) => e.content.filter((e) => e.type === "text").map((e) => e.text).join("\n\n"), ac = "ui://", oc = (e) => !!e?.startsWith(ac), sc = (e) => e.display === "text" || e.allowFreeform === !0, cc = {
	"allow-once": !0,
	"allow-always": !0,
	"reject-once": !1,
	"reject-always": !1
}, lc = (e, t) => {
	let n = t.text;
	if (n !== void 0 && !sc(e)) throw Error(`Tool approval "${e.id}" does not accept a free-form answer; the request must declare display "text" or allowFreeform`);
	let r, i;
	if ("optionId" in t) {
		let n = e.options?.find((e) => e.id === t.optionId);
		if (!n) throw Error(`Tool approval has no option with id "${t.optionId}"`);
		if ("approved" in t) r = t.approved;
		else {
			if (!Object.hasOwn(cc, n.kind)) throw Error(`Tool approval option "${n.id}" has a custom kind "${n.kind}"; respond with an explicit approved value instead`);
			r = cc[n.kind];
		}
		i = n.id;
	} else if ("approved" in t) r = t.approved;
	else {
		if (e.display !== "text" && e.display !== "select") throw Error(`Tool approval "${e.id}" is a decision, not a question; respond with an explicit approved value, optionally alongside the answer`);
		r = !0;
	}
	return {
		approvalId: e.id,
		approved: r,
		...i !== void 0 && { optionId: i },
		...n !== void 0 && { text: n },
		...t.reason != null && { reason: t.reason }
	};
}, uc = class {
	get path() {
		return this.contentBinding.path;
	}
	contentBinding;
	messageApi;
	threadApi;
	constructor(e, t, n) {
		this.contentBinding = e, this.messageApi = t, this.threadApi = n, this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.addToolResult = this.addToolResult.bind(this), this.resumeToolCall = this.resumeToolCall.bind(this), this.respondToToolApproval = this.respondToToolApproval.bind(this), this.getState = this.getState.bind(this), this.subscribe = this.subscribe.bind(this);
	}
	getState() {
		return this.contentBinding.getState();
	}
	addToolResult(e) {
		let t = this.contentBinding.getState();
		if (!t) throw Error("Message part is not available");
		if (t.type !== "tool-call") throw Error("Tried to add tool result to non-tool message part");
		if (!this.messageApi) throw Error("Message API is not available. This is likely a bug in assistant-ui.");
		if (!this.threadApi) throw Error("Thread API is not available");
		let n = this.messageApi.getState();
		if (!n) throw Error("Message is not available");
		let r = t.toolName, i = t.toolCallId, a = Va.toResponse(e);
		this.threadApi.getState().addToolResult({
			messageId: n.id,
			toolName: r,
			toolCallId: i,
			result: a.result,
			isError: a.isError,
			...a.artifact !== void 0 && { artifact: a.artifact },
			...a.modelContent !== void 0 && { modelContent: a.modelContent }
		});
	}
	resumeToolCall(e) {
		let t = this.contentBinding.getState();
		if (!t) throw Error("Message part is not available");
		if (t.type !== "tool-call") throw Error("Tried to resume tool call on non-tool message part");
		if (!this.threadApi) throw Error("Thread API is not available");
		let n = t.toolCallId;
		this.threadApi.getState().resumeToolCall({
			toolCallId: n,
			payload: e
		});
	}
	respondToToolApproval(e) {
		let t = this.contentBinding.getState();
		if (!t) throw Error("Message part is not available");
		if (t.type !== "tool-call") throw Error("Tried to respond to tool approval on non-tool message part");
		if (!t.approval || t.approval.approved !== void 0 || t.approval.resolution !== void 0) throw Error("Tool call has no pending approval");
		if (!this.threadApi) throw Error("Thread API is not available");
		return this.threadApi.getState().respondToToolApproval(lc(t.approval, e));
	}
	subscribe(e) {
		return this.contentBinding.subscribe(e);
	}
}, dc = (e, t) => {
	let n = e.content[t];
	if (!n) return ci;
	let r = na(e, t, n);
	return Object.freeze({
		...n,
		[as]: n[as],
		status: r
	});
}, fc = class {
	get path() {
		return this._core.path;
	}
	_core;
	_threadBinding;
	constructor(e, t) {
		this._core = e, this._threadBinding = t, this.composer = new rc(new gi({
			path: {
				...this.path,
				ref: `${this.path.ref}.composer`,
				composerSource: "edit"
			},
			getState: this._getEditComposerRuntimeCore,
			subscribe: (e) => this._threadBinding.subscribe(e)
		}), () => this._threadBinding.getState().beginEdit(this._core.getState().id)), this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.reload = this.reload.bind(this), this.delete = this.delete.bind(this), this.getState = this.getState.bind(this), this.subscribe = this.subscribe.bind(this), this.getMessagePartByIndex = this.getMessagePartByIndex.bind(this), this.getMessagePartByToolCallId = this.getMessagePartByToolCallId.bind(this), this.getAttachmentByIndex = this.getAttachmentByIndex.bind(this), this.unstable_getCopyText = this.unstable_getCopyText.bind(this), this.speak = this.speak.bind(this), this.stopSpeaking = this.stopSpeaking.bind(this), this.submitFeedback = this.submitFeedback.bind(this), this.switchToBranch = this.switchToBranch.bind(this);
	}
	composer;
	_getEditComposerRuntimeCore = () => this._threadBinding.getState().getEditComposer(this._core.getState().id);
	getState() {
		return this._core.getState();
	}
	delete() {
		let e = this._core.getState();
		return this._threadBinding.getState().deleteMessage(e.id);
	}
	reload(e = {}) {
		let t = this._getEditComposerRuntimeCore(), n = t ?? this._threadBinding.getState().composer, r = t ?? n, { runConfig: i = r.runConfig } = e, a = this._core.getState();
		if (a.role !== "assistant") throw Error("Can only reload assistant messages");
		this._threadBinding.getState().startRun({
			parentId: a.parentId,
			sourceId: a.id,
			runConfig: i
		});
	}
	speak() {
		let e = this._core.getState();
		return this._threadBinding.getState().speak(e.id);
	}
	stopSpeaking() {
		let e = this._core.getState();
		if (this._threadBinding.getState().speech?.messageId === e.id) this._threadBinding.getState().stopSpeaking();
		else throw Error("Message is not being spoken");
	}
	submitFeedback({ type: e, comment: t }) {
		let n = this._core.getState();
		this._threadBinding.getState().submitFeedback({
			messageId: n.id,
			type: e,
			...t === void 0 ? void 0 : { comment: t }
		});
	}
	switchToBranch({ position: e, branchId: t }) {
		let n = this._core.getState();
		if (t && e) throw Error("May not specify both branchId and position");
		if (!t && !e) throw Error("Must specify either branchId or position");
		let r = this._threadBinding.getState().getBranches(n.id), i = t;
		if (e === "previous" ? i = r[n.branchNumber - 2] : e === "next" && (i = r[n.branchNumber]), !i) throw Error("Branch not found");
		this._threadBinding.getState().switchToBranch(i);
	}
	unstable_getCopyText() {
		return ic(this.getState());
	}
	subscribe(e) {
		return this._core.subscribe(e);
	}
	getMessagePartByIndex(e) {
		if (e < 0) throw Error("Message part index must be >= 0");
		return new uc(new mi({
			path: {
				...this.path,
				ref: `${this.path.ref}.content[${e}]`,
				messagePartSelector: {
					type: "index",
					index: e
				}
			},
			getState: () => dc(this.getState(), e),
			subscribe: (e) => this._core.subscribe(e)
		}), this._core, this._threadBinding);
	}
	getMessagePartByToolCallId(e) {
		return new uc(new mi({
			path: {
				...this.path,
				ref: `${this.path.ref}.content[toolCallId=${JSON.stringify(e)}]`,
				messagePartSelector: {
					type: "toolCallId",
					toolCallId: e
				}
			},
			getState: () => {
				let t = this._core.getState(), n = t.content.findIndex((t) => t.type === "tool-call" && t.toolCallId === e);
				return n === -1 ? ci : dc(t, n);
			},
			subscribe: (e) => this._core.subscribe(e)
		}), this._core, this._threadBinding);
	}
	getAttachmentByIndex(e) {
		return new Xs(new mi({
			path: {
				...this.path,
				ref: `${this.path.ref}.attachments[${e}]`,
				attachmentSource: "message",
				attachmentSelector: {
					type: "index",
					index: e
				}
			},
			getState: () => {
				let t = this.getState().attachments?.[e];
				return t ? {
					...t,
					source: "message"
				} : ci;
			},
			subscribe: (e) => this._core.subscribe(e)
		}));
	}
}, pc = (e) => ({
	parentId: e.parentId ?? null,
	sourceId: e.sourceId ?? null,
	runConfig: e.runConfig ?? {},
	...e.stream ? { stream: e.stream } : {}
}), mc = (e) => ({
	parentId: e.parentId ?? null,
	sourceId: e.sourceId ?? null,
	runConfig: e.runConfig ?? {}
}), hc = (e, t) => typeof t == "string" ? {
	createdAt: /* @__PURE__ */ new Date(),
	parentId: e.at(-1)?.id ?? null,
	sourceId: null,
	runConfig: {},
	role: "user",
	content: [{
		type: "text",
		text: t
	}],
	attachments: [],
	metadata: { custom: {} }
} : {
	createdAt: t.createdAt ?? /* @__PURE__ */ new Date(),
	parentId: t.parentId === void 0 ? e.at(-1)?.id ?? null : t.parentId,
	sourceId: t.sourceId ?? null,
	role: t.role ?? "user",
	content: t.content,
	attachments: t.attachments ?? [],
	metadata: t.metadata ?? { custom: {} },
	runConfig: t.runConfig ?? {},
	startRun: t.startRun
}, gc = (e) => {
	if (e.isRunning !== void 0) return e.isRunning;
	let t = e.messages.at(-1);
	return t?.role === "assistant" && t.status.type === "running";
}, _c = (e, t) => Object.freeze({
	threadId: t.id,
	metadata: t,
	capabilities: e.capabilities,
	isDisabled: e.isDisabled,
	isLoading: e.isLoading,
	isRunning: gc(e),
	messages: e.messages,
	state: e.state,
	suggestions: e.suggestions,
	extras: e.extras,
	speech: e.speech,
	voice: e.voice
}), vc = class {
	get path() {
		return this._threadBinding.path;
	}
	get __internal_threadBinding() {
		return this._threadBinding;
	}
	_threadBinding;
	_stateBinding;
	constructor(e, t) {
		let n = new mi({
			path: e.path,
			getState: () => _c(e.getState(), t.getState()),
			subscribe: (n) => {
				let r = e.subscribe(n), i = t.subscribe(n);
				return () => ui([r, i]);
			}
		});
		this._stateBinding = n, this._threadBinding = {
			path: e.path,
			getState: () => e.getState(),
			getStateState: () => n.getState(),
			outerSubscribe: (t) => e.outerSubscribe(t),
			subscribe: (t) => e.subscribe(t)
		}, this.composer = new nc(new gi({
			path: {
				...this.path,
				ref: `${this.path.ref}.composer`,
				composerSource: "thread"
			},
			getState: () => this._threadBinding.getState().composer,
			subscribe: (e) => this._threadBinding.subscribe(e)
		})), this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.append = this.append.bind(this), this.deleteMessage = this.deleteMessage.bind(this), this.resumeRun = this.resumeRun.bind(this), this.importExternalState = this.importExternalState.bind(this), this.exportExternalState = this.exportExternalState.bind(this), this.startRun = this.startRun.bind(this), this.cancelRun = this.cancelRun.bind(this), this.unstable_notifySessionReset = this.unstable_notifySessionReset.bind(this), this.stopSpeaking = this.stopSpeaking.bind(this), this.connectVoice = this.connectVoice.bind(this), this.disconnectVoice = this.disconnectVoice.bind(this), this.muteVoice = this.muteVoice.bind(this), this.unmuteVoice = this.unmuteVoice.bind(this), this.getVoiceVolume = this.getVoiceVolume.bind(this), this.subscribeVoiceVolume = this.subscribeVoiceVolume.bind(this), this.export = this.export.bind(this), this.import = this.import.bind(this), this.reset = this.reset.bind(this), this.getMessageByIndex = this.getMessageByIndex.bind(this), this.getMessageById = this.getMessageById.bind(this), this.subscribe = this.subscribe.bind(this), this.unstable_on = this.unstable_on.bind(this), this.getModelContext = this.getModelContext.bind(this), this.getState = this.getState.bind(this);
	}
	composer;
	getState() {
		return this._threadBinding.getStateState();
	}
	append(e) {
		let t = this._threadBinding.getState().append(hc(this._threadBinding.getState().messages, e));
		Promise.resolve(t).catch((e) => {
			if (!Gs(e)) throw e;
		});
	}
	deleteMessage(e) {
		return this._threadBinding.getState().deleteMessage(e);
	}
	subscribe(e) {
		return this._stateBinding.subscribe(e);
	}
	getModelContext() {
		return this._threadBinding.getState().getModelContext();
	}
	startRun(e) {
		return this._threadBinding.getState().startRun(mc(e));
	}
	resumeRun(e) {
		return this._threadBinding.getState().resumeRun(pc(e));
	}
	exportExternalState() {
		return this._threadBinding.getState().exportExternalState();
	}
	importExternalState(e) {
		this._threadBinding.getState().importExternalState(e);
	}
	cancelRun() {
		this._threadBinding.getState().cancelRun();
	}
	unstable_notifySessionReset() {
		this._threadBinding.getState().unstable_notifySessionReset();
	}
	stopSpeaking() {
		return this._threadBinding.getState().stopSpeaking();
	}
	connectVoice() {
		this._threadBinding.getState().connectVoice();
	}
	disconnectVoice() {
		this._threadBinding.getState().disconnectVoice();
	}
	getVoiceVolume() {
		return this._threadBinding.getState().getVoiceVolume();
	}
	subscribeVoiceVolume(e) {
		return this._threadBinding.getState().subscribeVoiceVolume(e);
	}
	muteVoice() {
		this._threadBinding.getState().muteVoice();
	}
	unmuteVoice() {
		this._threadBinding.getState().unmuteVoice();
	}
	export() {
		return this._threadBinding.getState().export();
	}
	import(e) {
		this._threadBinding.getState().import(e);
	}
	reset(e) {
		this._threadBinding.getState().reset(e);
	}
	getMessageByIndex(e) {
		if (e < 0) throw Error("Message index must be >= 0");
		return this._getMessageRuntime({
			...this.path,
			ref: `${this.path.ref}.messages[${e}]`,
			messageSelector: {
				type: "index",
				index: e
			}
		}, () => {
			let t = this._threadBinding.getState().messages, n = t[e];
			if (n) return {
				message: n,
				parentId: t[e - 1]?.id ?? null,
				index: e
			};
		});
	}
	getMessageById(e) {
		return this._getMessageRuntime({
			...this.path,
			ref: `${this.path.ref}.messages[messageId=${JSON.stringify(e)}]`,
			messageSelector: {
				type: "messageId",
				messageId: e
			}
		}, () => this._threadBinding.getState().getMessageById(e));
	}
	_getMessageRuntime(e, t) {
		return new fc(new mi({
			path: e,
			getState: () => {
				let { message: e, parentId: n, index: r } = t() ?? {}, { messages: i, speech: a } = this._threadBinding.getState();
				if (!e || n === void 0 || r === void 0) return ci;
				let o = this._threadBinding.getState().getBranches(e.id);
				return {
					...e,
					[as]: e[as],
					index: r,
					isLast: i.at(-1)?.id === e.id,
					parentId: n,
					branchNumber: o.indexOf(e.id) + 1,
					branchCount: o.length,
					speech: a?.messageId === e.id ? a : void 0
				};
			},
			subscribe: (e) => this._threadBinding.subscribe(e)
		}), this._threadBinding);
	}
	_eventSubscriptionSubjects = /* @__PURE__ */ new Map();
	unstable_on(e, t) {
		let n = this._eventSubscriptionSubjects.get(e);
		return n || (n = new _i({
			event: e,
			binding: this._threadBinding
		}), this._eventSubscriptionSubjects.set(e, n)), n.subscribe(t);
	}
}, yc = class {
	get path() {
		return this._core.path;
	}
	_core;
	_threadListBinding;
	constructor(e, t) {
		this._core = e, this._threadListBinding = t, this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.switchTo = this.switchTo.bind(this), this.rename = this.rename.bind(this), this.updateCustom = this.updateCustom.bind(this), this.archive = this.archive.bind(this), this.unarchive = this.unarchive.bind(this), this.delete = this.delete.bind(this), this.initialize = this.initialize.bind(this), this.generateTitle = this.generateTitle.bind(this), this.subscribe = this.subscribe.bind(this), this.unstable_on = this.unstable_on.bind(this), this.getState = this.getState.bind(this), this.detach = this.detach.bind(this);
	}
	getState() {
		return this._core.getState();
	}
	switchTo(e) {
		let t = this._core.getState();
		return this._threadListBinding.switchToThread(t.id, e);
	}
	rename(e) {
		let t = this._core.getState();
		return this._threadListBinding.rename(t.id, e);
	}
	updateCustom(e) {
		let t = this._core.getState();
		if (!this._threadListBinding.updateCustom) throw Error("Thread list runtime does not support updating custom metadata");
		return this._threadListBinding.updateCustom(t.id, e);
	}
	archive() {
		let e = this._core.getState();
		return this._threadListBinding.archive(e.id);
	}
	unarchive() {
		let e = this._core.getState();
		return this._threadListBinding.unarchive(e.id);
	}
	delete() {
		let e = this._core.getState();
		return this._threadListBinding.delete(e.id);
	}
	initialize() {
		let e = this._core.getState();
		return this._threadListBinding.initialize(e.id);
	}
	generateTitle(e) {
		let t = this._core.getState();
		return this._threadListBinding.generateTitle(t.id, e);
	}
	unstable_on(e, t) {
		let n = this._core.getState().isMain, r = this._core.getState().id;
		return this.subscribe(() => {
			let i = this._core.getState(), a = i.isMain, o = i.id;
			(n !== a || r !== o) && (n = a, r = o, (e !== "switchedTo" || a) && (e === "switchedAway" && a || _n([t], {}, `Thread list item "${e}"`)));
		});
	}
	subscribe(e) {
		return this._core.subscribe(e);
	}
	detach() {
		let e = this._core.getState();
		this._threadListBinding.detach(e.id);
	}
	__internal_getRuntime() {
		return this;
	}
}, bc = Promise.resolve(), xc = () => {}, Sc = (e) => ({
	mainThreadId: e.mainThreadId,
	newThreadId: e.newThreadId,
	threadIds: e.threadIds,
	archivedThreadIds: e.archivedThreadIds,
	isLoading: e.isLoading,
	loadError: e.loadError,
	isLoadingMore: e.isLoadingMore ?? !1,
	hasMore: e.hasMore ?? !1,
	threadItems: e.threadItems
}), Cc = (e, t) => {
	if (t === void 0) return ci;
	let n = e.getItemById(t);
	return n ? {
		id: n.id,
		remoteId: n.remoteId,
		externalId: n.externalId,
		title: n.title,
		status: n.status,
		lastMessageAt: n.lastMessageAt,
		custom: n.custom,
		isMain: n.id === e.mainThreadId,
		isRunning: e.unstable_isThreadRunning?.(n.id) ?? !1
	} : ci;
}, wc = class {
	_getState;
	_stateBinding;
	_core;
	_runtimeFactory;
	constructor(e, t = vc) {
		this._core = e, this._runtimeFactory = t;
		let n = new hi({
			path: {},
			getState: () => Sc(e),
			subscribe: (t) => e.subscribe(t)
		});
		this._getState = n.getState.bind(n), this._stateBinding = n, this._mainThreadListItemRuntime = new yc(new mi({
			path: {
				ref: "threadItems[main]",
				threadSelector: { type: "main" }
			},
			getState: () => Cc(this._core, this._core.mainThreadId),
			subscribe: (e) => this._core.subscribe(e)
		}), this._core), this.main = new t(new gi({
			path: {
				ref: "threads.main",
				threadSelector: { type: "main" }
			},
			getState: () => e.getMainThreadRuntimeCore(),
			subscribe: (t) => e.subscribe(t)
		}), this._mainThreadListItemRuntime), this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.switchToThread = this.switchToThread.bind(this), this.switchToNewThread = this.switchToNewThread.bind(this), this.unstable_subscribeThreadEvents = this.unstable_subscribeThreadEvents.bind(this), this.getLoadThreadsPromise = this.getLoadThreadsPromise.bind(this), this.reload = this.reload.bind(this), this.reloadMainThread = this.reloadMainThread.bind(this), this.loadMore = this.loadMore.bind(this), this.getState = this.getState.bind(this), this.subscribe = this.subscribe.bind(this), this.getById = this.getById.bind(this), this.getItemById = this.getItemById.bind(this), this.getItemByIndex = this.getItemByIndex.bind(this), this.getArchivedItemByIndex = this.getArchivedItemByIndex.bind(this);
	}
	switchToThread(e, t) {
		return this._core.switchToThread(e, t);
	}
	switchToNewThread() {
		return this._core.switchToNewThread();
	}
	unstable_subscribeThreadEvents(e) {
		return this._core.unstable_subscribeThreadEvents?.(e) ?? xc;
	}
	getLoadThreadsPromise() {
		return this._core.getLoadThreadsPromise();
	}
	reload() {
		return this._core.reload?.() ?? bc;
	}
	reloadMainThread() {
		return this._core.reloadMainThread?.() ?? bc;
	}
	loadMore() {
		return this._core.loadMore?.() ?? bc;
	}
	getState() {
		return this._getState();
	}
	subscribe(e) {
		return this._stateBinding.subscribe(e);
	}
	_mainThreadListItemRuntime;
	main;
	get mainItem() {
		return this._mainThreadListItemRuntime;
	}
	_createItemStateBinding(e) {
		return new mi({
			path: {
				ref: `threadItems[threadId=${e}]`,
				threadSelector: {
					type: "threadId",
					threadId: e
				}
			},
			getState: () => Cc(this._core, e),
			subscribe: (e) => this._core.subscribe(e)
		});
	}
	getById(e) {
		return new this._runtimeFactory(new gi({
			path: {
				ref: `threads[threadId=${JSON.stringify(e)}]`,
				threadSelector: {
					type: "threadId",
					threadId: e
				}
			},
			getState: () => this._core.getThreadRuntimeCore(e),
			subscribe: (e) => this._core.subscribe(e)
		}), this._createItemStateBinding(e));
	}
	getItemByIndex(e) {
		return new yc(new mi({
			path: {
				ref: `threadItems[${e}]`,
				threadSelector: {
					type: "index",
					index: e
				}
			},
			getState: () => Cc(this._core, this._core.threadIds[e]),
			subscribe: (e) => this._core.subscribe(e)
		}), this._core);
	}
	getArchivedItemByIndex(e) {
		return new yc(new mi({
			path: {
				ref: `archivedThreadItems[${e}]`,
				threadSelector: {
					type: "archiveIndex",
					index: e
				}
			},
			getState: () => Cc(this._core, this._core.archivedThreadIds[e]),
			subscribe: (e) => this._core.subscribe(e)
		}), this._core);
	}
	getItemById(e) {
		return new yc(this._createItemStateBinding(e), this._core);
	}
}, Tc = class {
	threads;
	_thread;
	_core;
	constructor(e) {
		this._core = e, this.threads = new wc(e.threads), this._thread = this.threads.main, this.__internal_bindMethods();
	}
	__internal_bindMethods() {
		this.registerModelContextProvider = this.registerModelContextProvider.bind(this);
	}
	get thread() {
		return this._thread;
	}
	registerModelContextProvider(e) {
		return this._core.registerModelContextProvider(e);
	}
}, Ec = /* @__PURE__ */ new WeakMap(), Dc = (e) => Ec.get(e) ?? 0, Oc = (e, t) => Dc(e) === t, kc = (e) => {
	Ec.set(e, Dc(e) + 1);
}, Ac = class {
	_contextProvider = new vi();
	registerModelContextProvider(e) {
		return this._contextProvider.registerModelContextProvider(e);
	}
	getModelContextProvider() {
		return this._contextProvider;
	}
}, jc = Object.freeze([]), Mc = "DEFAULT_THREAD_ID", Nc = Object.freeze([Mc]), Pc = Object.freeze({
	id: Mc,
	remoteId: void 0,
	externalId: void 0,
	status: "regular"
}), Fc = Promise.resolve(), Ic = Object.freeze(P({ [Mc]: Pc })), Lc = class extends fi {
	_mainThreadId = Mc;
	_threads = Nc;
	_archivedThreads = jc;
	_threadData = Ic;
	adapter = {};
	get isLoading() {
		return this.adapter.isLoading ?? !1;
	}
	get newThreadId() {}
	get threadIds() {
		return this._threads;
	}
	get archivedThreadIds() {
		return this._archivedThreads;
	}
	get threadItems() {
		return this._threadData;
	}
	getLoadThreadsPromise() {
		return Fc;
	}
	_mainThread;
	get mainThreadId() {
		return this._mainThreadId;
	}
	threadFactory;
	constructor(e = {}, t) {
		super(), this.threadFactory = t, this.__internal_setAdapter(e, !0);
	}
	getMainThreadRuntimeCore() {
		return this._mainThread;
	}
	getThreadRuntimeCore() {
		throw Error("Method not implemented.");
	}
	getItemById(e) {
		return Object.hasOwn(this._threadData, e) ? this._threadData[e] : void 0;
	}
	__internal_setAdapter(e, t = !1) {
		let n = this.adapter;
		this.adapter = e;
		let r = e.threadId ?? Mc, i = e.threads ?? jc, a = e.archivedThreads ?? jc, o = n.threadId ?? Mc, s = n.threads ?? jc, c = n.archivedThreads ?? jc;
		(t || (n.isLoading ?? !1) !== (e.isLoading ?? !1) || o !== r || s !== i || c !== a) && ((s !== i || c !== a || o !== r) && (this._threadData = P(Ic, Object.fromEntries(e.threads?.map((e) => [e.id, {
			...e,
			remoteId: e.remoteId,
			externalId: e.externalId,
			status: "regular"
		}]) ?? []), Object.fromEntries(e.archivedThreads?.map((e) => [e.id, {
			...e,
			remoteId: e.remoteId,
			externalId: e.externalId,
			status: "archived"
		}]) ?? []))), s !== i && (this._threads = this.adapter.threads?.map((e) => e.id) ?? jc), c !== a && (this._archivedThreads = this.adapter.archivedThreads?.map((e) => e.id) ?? jc), (t || o !== r) && (t || kc(this._mainThread), this._mainThreadId = r, this._mainThread = this.threadFactory()), Object.hasOwn(this._threadData, this._mainThreadId) || (this._threadData = P(this._threadData, { [this._mainThreadId]: {
			id: this._mainThreadId,
			remoteId: void 0,
			externalId: void 0,
			status: "regular"
		} })), this._notifySubscribers());
	}
	async reloadMainThread() {
		this._mainThread.unstable_refetchThread && await this._mainThread.unstable_refetchThread();
	}
	async switchToThread(e, t) {
		if (this._mainThreadId === e) return;
		let n = this.adapter.onSwitchToThread;
		if (!n) throw Error("External store adapter does not support switching to thread");
		await n(e);
	}
	async switchToNewThread() {
		let e = this.adapter.onSwitchToNewThread;
		if (!e) throw Error("External store adapter does not support switching to new thread");
		await e();
	}
	async rename(e, t) {
		let n = this.adapter.onRename;
		if (!n) throw Error("External store adapter does not support renaming");
		await n(e, t);
	}
	async updateCustom(e, t) {
		let n = this.adapter.onUpdateCustom;
		if (!n) throw Error("External store adapter does not support updating custom metadata");
		await n(e, t);
	}
	async detach() {}
	async archive(e) {
		let t = this.adapter.onArchive;
		if (!t) throw Error("External store adapter does not support archiving");
		await t(e);
	}
	async unarchive(e) {
		let t = this.adapter.onUnarchive;
		if (!t) throw Error("External store adapter does not support unarchiving");
		await t(e);
	}
	async delete(e) {
		let t = this.adapter.onDelete;
		if (!t) throw Error("External store adapter does not support deleting");
		await t(e);
	}
	initialize(e) {
		return Promise.resolve({
			remoteId: e,
			externalId: void 0
		});
	}
	generateTitle() {
		throw Error("Method not implemented.");
	}
}, Rc = {
	fromArray: (e) => {
		let t = e.map((e) => ms(e, ds(), Es(e.content)));
		return { messages: t.map((e, n) => ({
			parentId: n > 0 ? t[n - 1].id : null,
			message: e
		})) };
	},
	fromBranchableArray: (e, t) => ({
		...t?.headId === void 0 ? void 0 : { headId: t.headId },
		messages: e.map(({ message: e, parentId: t }) => {
			if (!e.id) throw Error("ExportedMessageRepository.fromBranchableArray: Each message must have an 'id' field set.");
			return {
				parentId: t,
				message: ms(e, e.id, Es(e.content))
			};
		})
	})
}, zc = (e) => {
	let t = e;
	for (; t.next;) t = t.next;
	return "current" in t ? t : null;
}, Bc = class {
	_value = null;
	func;
	constructor(e) {
		this.func = e;
	}
	get value() {
		return this._value === null && (this._value = this.func()), this._value;
	}
	dirty() {
		this._value = null;
	}
}, Vc = class {
	messages = /* @__PURE__ */ new Map();
	head = null;
	root = {
		children: [],
		next: null
	};
	updateLevels(e, t) {
		let n = [{
			message: e,
			level: t
		}];
		for (; n.length > 0;) {
			let e = n.pop();
			e.message.level = e.level;
			for (let t of e.message.children) {
				let r = this.messages.get(t);
				r && n.push({
					message: r,
					level: e.level + 1
				});
			}
		}
	}
	selectPathTo(e) {
		for (let t = e; t; t = t.prev) (t.prev ?? this.root).next = t;
	}
	performOp(e, t, n) {
		let r = t.prev ?? this.root, i = e ?? this.root;
		if (n !== "relink" || r !== i) {
			if (n === "relink") {
				for (let n = e; n; n = n.prev) if (n.current.id === t.current.id) throw Error("MessageRepository(performOp/relink): A message with the same id already exists in the parent tree. This error occurs if the same message id is found multiple times. This is likely an internal bug in assistant-ui.");
			}
			if (n !== "link" && (r.children = r.children.filter((e) => e !== t.current.id), r.next === t)) {
				let e = r.children.at(-1), t = e ? this.messages.get(e) : null;
				if (t === void 0) throw Error("MessageRepository(performOp/cut): Fallback sibling message not found. This is likely an internal bug in assistant-ui.");
				r.next = t;
			}
			if (n !== "cut") {
				i.children = [...i.children, t.current.id], t.prev = e, zc(t) === this.head ? this.selectPathTo(t) : i.next === null && (i.next = t, this.head === i && (this.head = zc(t)));
				let n = e ? e.level + 1 : 0;
				this.updateLevels(t, n);
			}
		}
	}
	_messages = new Bc(() => {
		let e = Array((this.head?.level ?? -1) + 1);
		for (let t = this.head; t; t = t.prev) e[t.level] = t.current;
		return e;
	});
	get headId() {
		return this.head?.current.id ?? null;
	}
	get canonicalHeadId() {
		let e = this.head;
		for (; e?.current.metadata?.isOptimistic;) e = e.prev;
		return e?.current.id ?? null;
	}
	getMessages(e) {
		if (e === void 0 || e === this.head?.current.id) return this._messages.value;
		let t = this.messages.get(e);
		if (!t) throw Error("MessageRepository(getMessages): Head message not found. This is likely an internal bug in assistant-ui.");
		let n = Array(t.level + 1);
		for (let e = t; e; e = e.prev) n[e.level] = e.current;
		return n;
	}
	addOrUpdateMessage(e, t) {
		let n = this.messages.get(t.id), r = e ? this.messages.get(e) : null;
		if (r === void 0) throw Error("MessageRepository(addOrUpdateMessage): Parent message not found. This is likely an internal bug in assistant-ui.");
		if (n) {
			n.current = t, this.performOp(r, n, "relink"), this._messages.dirty();
			return;
		}
		let i = {
			prev: r,
			current: t,
			next: null,
			children: [],
			level: r ? r.level + 1 : 0
		};
		this.messages.set(t.id, i), this.performOp(r, i, "link"), this.head === r && (this.head = i), this._messages.dirty();
	}
	getMessage(e) {
		let t = this.messages.get(e);
		if (!t) throw Error("MessageRepository(updateMessage): Message not found. This is likely an internal bug in assistant-ui.");
		return {
			parentId: t.prev?.current.id ?? null,
			message: t.current,
			index: t.level
		};
	}
	deleteMessage(e, t) {
		let n = this.messages.get(e);
		if (!n) throw Error("MessageRepository(deleteMessage): Message not found. This is likely an internal bug in assistant-ui.");
		let r = t === void 0 ? n.prev : t === null ? null : this.messages.get(t);
		if (r === void 0) throw Error("MessageRepository(deleteMessage): Replacement not found. This is likely an internal bug in assistant-ui.");
		for (let e of n.children) {
			let t = this.messages.get(e);
			if (!t) throw Error("MessageRepository(deleteMessage): Child message not found. This is likely an internal bug in assistant-ui.");
			this.performOp(r, t, "relink");
		}
		this.performOp(null, n, "cut"), this.messages.delete(e), this.head === n && (this.head = zc(r ?? this.root)), this._messages.dirty();
	}
	getBranches(e) {
		let t = this.messages.get(e);
		if (!t) throw Error("MessageRepository(getBranches): Message not found. This is likely an internal bug in assistant-ui.");
		let { children: n } = t.prev ?? this.root;
		return n;
	}
	evictOffBranchOptimisticMessages(e, t) {
		if (!e) return;
		let n = /* @__PURE__ */ new Set();
		for (let e = t; e; e = e.prev) n.add(e.current.id);
		let r = [];
		for (let t = e; t && !n.has(t.current.id); t = t.prev) t.current.metadata?.isOptimistic && r.push(t.current.id);
		for (let e of r) this.messages.has(e) && this.deleteMessage(e);
	}
	switchToBranch(e) {
		let t = this.messages.get(e);
		if (!t) throw Error("MessageRepository(switchToBranch): Branch not found. This is likely an internal bug in assistant-ui.");
		let n = this.head;
		this.selectPathTo(t), this.head = zc(t), this.evictOffBranchOptimisticMessages(n, this.head), this._messages.dirty();
	}
	resetHead(e) {
		if (e === null) {
			this.clear();
			return;
		}
		let t = this.messages.get(e);
		if (!t) throw Error("MessageRepository(resetHead): Branch not found. This is likely an internal bug in assistant-ui.");
		let n = this.head;
		if (t.children.length > 0) {
			let e = [...t.children];
			for (; e.length > 0;) {
				let t = e.pop(), n = this.messages.get(t);
				if (n) {
					for (let t of n.children) e.push(t);
					this.messages.delete(t);
				}
			}
			t.children = [], t.next = null;
		}
		this.head = t, this.selectPathTo(t), this.evictOffBranchOptimisticMessages(n, this.head), this._messages.dirty();
	}
	clear() {
		this.messages.clear(), this.head = null, this.root = {
			children: [],
			next: null
		}, this._messages.dirty();
	}
	export() {
		let e = [], t = [...this.root.children].reverse();
		for (; t.length > 0;) {
			let n = this.messages.get(t.pop());
			if (!n) continue;
			for (let e = n.children.length - 1; e >= 0; e--) t.push(n.children[e]);
			if (n.current.metadata?.isOptimistic) continue;
			let r = n.prev;
			for (; r && r.current.metadata?.isOptimistic;) r = r.prev;
			e.push({
				message: n.current,
				parentId: r?.current.id ?? null
			});
		}
		return {
			headId: this.canonicalHeadId,
			messages: e
		};
	}
	import({ headId: e, messages: t }) {
		for (let { message: e, parentId: n } of t) this.addOrUpdateMessage(n, e);
		this.resetHead(e ?? t.at(-1)?.message.id ?? null);
	}
}, Hc = Object.freeze([]);
//#endregion
//#region node_modules/@assistant-ui/core/dist/runtime/utils/tool-call-tree.js
function* Uc(e) {
	for (let t of e) if (t?.role === "assistant" && Array.isArray(t.content)) for (let e of t.content) e && e.type === "tool-call" && (yield {
		part: e,
		messageId: t.id
	}, e.messages?.length && (yield* Uc(e.messages)));
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/adapters/attachment.js
function Wc(e, t) {
	if (t === "*") return !0;
	let n = t.split(",").map((e) => e.trim().toLowerCase()), r = e.name.toLowerCase(), i = e.type.split(";", 1)[0].trim().toLowerCase();
	for (let e of n) {
		if (e.startsWith(".") && r.endsWith(e) || e.includes("/") && e === i) return !0;
		if (e.endsWith("/*")) {
			let t = e.split("/")[0];
			if (i.startsWith(`${t}/`)) return !0;
		}
	}
	return !1;
}
function Gc(e) {
	let t = ds();
	return e.type === "image" ? {
		id: t,
		type: "image",
		name: e.filename ?? "image",
		content: [e],
		status: { type: "complete" }
	} : e.type === "file" ? {
		id: t,
		type: "document",
		name: e.filename ?? "document",
		contentType: e.mimeType,
		content: [e],
		status: { type: "complete" }
	} : e.type === "audio" ? {
		id: t,
		type: "audio",
		name: `audio.${e.audio.format}`,
		contentType: `audio/${e.audio.format}`,
		content: [e],
		status: { type: "complete" }
	} : {
		id: t,
		type: "data",
		name: e.name,
		content: [e],
		status: { type: "complete" }
	};
}
function Kc(e) {
	let t = [];
	for (let n of e) n.type !== "text" && t.push(Gc(n));
	return t;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/types/attachment.js
var qc = (e) => "content" in e && !("lastModified" in e), Jc = (e) => e.status.type === "complete", Yc = class {
	operations = /* @__PURE__ */ new Set();
	start() {
		let e = {
			cancelled: !1,
			attachmentIds: /* @__PURE__ */ new Set()
		};
		return this.operations.add(e), e;
	}
	accept(e, t) {
		return !e.cancelled && (e.attachmentIds.add(t), !0);
	}
	finish(e) {
		this.operations.delete(e);
	}
	isCancelled(e) {
		return e.cancelled;
	}
	cancel(e) {
		for (let t of [...this.operations]) t.attachmentIds.has(e) && (t.cancelled = !0, this.operations.delete(t));
	}
	cancelAll() {
		for (let e of this.operations) e.cancelled = !0;
		this.operations.clear();
	}
}, Xc = async (e, t) => {
	if (Symbol.asyncIterator in e) {
		for await (let n of e) if (!t(n)) break;
	} else t(await e);
}, Zc = class extends fi {
	isEditing = !0;
	enrichWithComposerMetadata(e, t) {
		return t ? {
			...e,
			metadata: {
				...e.metadata,
				custom: {
					...e.metadata?.custom,
					...t
				}
			}
		} : e;
	}
	get attachmentAccept() {
		return this.getAttachmentAdapter()?.accept ?? "*";
	}
	_attachments = [];
	get attachments() {
		return this._attachments;
	}
	setAttachments(e) {
		this._attachments = e, this._notifySubscribers();
	}
	get isEmpty() {
		return !this.text.trim() && !this.attachments.length;
	}
	_text = "";
	get text() {
		return this._text;
	}
	_role = "user";
	get role() {
		return this._role;
	}
	_runConfig = {};
	get runConfig() {
		return this._runConfig;
	}
	_quote = void 0;
	get quote() {
		return this._quote;
	}
	setQuote(e) {
		this._quote !== e && (this._quote = e, this._notifySubscribers());
	}
	setText(e) {
		this._text !== e && (this._text = e, this._rebaseDictation(e), this._notifySubscribers());
	}
	_rebaseDictation(e) {
		if (!this._dictation) return;
		this._dictationBaseText = e, this._currentInterimText = "";
		let { status: t, inputDisabled: n } = this._dictation;
		this._dictation = n ? {
			status: t,
			inputDisabled: n
		} : { status: t };
	}
	setRole(e) {
		this._role !== e && (this._role = e, this._notifySubscribers());
	}
	setRunConfig(e) {
		this._runConfig !== e && (this._runConfig = e, this._notifySubscribers());
	}
	_isSending = !1;
	_removedDuringSend = /* @__PURE__ */ new Set();
	_sendGeneration = 0;
	_attachmentAddOperations = new Yc();
	_cancelAttachmentAdd(e) {
		this._attachmentAddOperations.cancel(e);
	}
	_cancelAllAttachmentAdds() {
		this._attachmentAddOperations.cancelAll();
	}
	_emptyTextAndAttachments() {
		this._attachments = [], this._text = "", this._rebaseDictation(""), this._notifySubscribers();
	}
	async _onClearAttachments() {
		let e = this.getAttachmentAdapter();
		if (e) {
			let t = this._attachments.filter((e) => !Jc(e));
			await Promise.all(t.map(async (t) => e.remove(t)));
		}
	}
	async reset() {
		if (this._cancelAllAttachmentAdds(), this._sendGeneration++, this._isSending = !1, this._removedDuringSend.clear(), this._attachments.length === 0 && this._text === "" && this._role === "user" && Object.keys(this._runConfig).length === 0 && this._quote === void 0) return;
		this._role = "user", this._runConfig = {}, this._quote = void 0;
		let e = this._onClearAttachments();
		this._emptyTextAndAttachments(), await e;
	}
	async clearAttachments() {
		if (this._cancelAllAttachmentAdds(), this._isSending) for (let e of this._attachments) this._removedDuringSend.add(e.id);
		let e = this._onClearAttachments();
		this.setAttachments([]), await e;
	}
	async send(e) {
		if (!this.canSend || this._isSending) return;
		if (this._dictationSession) try {
			this._dictationSession.cancel();
		} catch (e) {
			console.error("[assistant-ui] Dictation session cancel threw", e);
		} finally {
			this._cleanupDictation();
		}
		let t = this.getAttachmentAdapter(), n = this.attachments.map(async (e) => {
			if (Jc(e)) return e;
			if (!t) throw Error("Attachments are not supported");
			return await t.send(e);
		}), r = this.attachments, i = this.text, a = this._quote, o = this.role, s = this.runConfig;
		this._quote = void 0, this._text = "", this._isSending = !0;
		let c = ++this._sendGeneration;
		this._notifySubscribers();
		let l;
		try {
			l = await Promise.all(n);
		} catch (e) {
			throw c === this._sendGeneration && (!this.text.trim() && this._quote === void 0 && (this._text = i, this._rebaseDictation(i), this._quote = a, this._notifySubscribers()), Promise.allSettled(n).then(() => {
				c === this._sendGeneration && (this._removedDuringSend.clear(), this._isSending = !1, this._notifySubscribers());
			})), e;
		}
		if (c !== this._sendGeneration) return;
		let u = new Set(r.map((e) => e.id));
		this._attachments = this._attachments.filter((e) => !u.has(e.id)), this._isSending = !1, this._notifySubscribers();
		let d = l.filter((e) => !this._removedDuringSend.has(e.id));
		this._removedDuringSend.clear();
		let f = {
			createdAt: /* @__PURE__ */ new Date(),
			role: o,
			content: i ? [{
				type: "text",
				text: i
			}] : [],
			attachments: d,
			runConfig: s,
			metadata: { custom: { ...a ? { quote: a } : {} } }
		}, p = {
			text: i,
			quote: a,
			attachments: d
		}, m;
		try {
			m = this.handleSend(f, e);
		} catch (e) {
			throw this._restoreUnsentDraft(e, c, p), e;
		}
		m && m.catch((e) => {
			this._restoreUnsentDraft(e, c, p);
		}), this._notifyEventSubscribers("send", {
			chars: i.length,
			attachments: d.length
		});
	}
	restoreDraft(e) {
		return this._text.trim() || this._quote !== void 0 || this._attachments.length > 0 ? !1 : (this._text = e.text, this._rebaseDictation(e.text), this._quote = e.quote, this._attachments = e.attachments ?? [], this._notifySubscribers(), !0);
	}
	retractDraft(e) {
		let t = e.attachments === void 0 ? this._attachments.length === 0 : this._attachments === e.attachments;
		this._text === e.text && this._quote === e.quote && t && (this._text = "", this._rebaseDictation(""), this._quote = void 0, this._attachments = [], this._notifySubscribers());
	}
	_restoreUnsentDraft(e, t, n) {
		Gs(e) && t === this._sendGeneration && this.restoreDraft(n);
	}
	cancel() {
		this.handleCancel();
	}
	get queue() {
		return Hc;
	}
	moveQueueItem(e, t) {}
	removeQueueItem(e) {}
	async addAttachment(e) {
		if (qc(e)) {
			let t = this.getAttachmentAdapter();
			if (t && !Wc({
				name: e.name,
				type: e.contentType ?? ""
			}, t.accept)) {
				let n = `File type ${e.contentType || "unknown"} is not accepted. Accepted types: ${t.accept}`, r = Error(n);
				throw this._safeEmitAttachmentAddError("not-accepted", n, void 0, r, e.contentType), r;
			}
			let n = {
				id: e.id ?? ds(),
				type: e.type ?? "document",
				name: e.name,
				contentType: e.contentType,
				content: e.content,
				status: { type: "complete" }
			};
			this._attachments = [...this._attachments, n], this._notifySubscribers(), this._notifyEventSubscribers("attachmentAdd", { ...n.contentType ? { contentType: n.contentType } : void 0 });
			return;
		}
		let t = this.getAttachmentAdapter();
		if (!t) {
			let t = "Attachments are not supported", n = /* @__PURE__ */ Error(t);
			throw this._safeEmitAttachmentAddError("no-adapter", t, void 0, n, e.type), n;
		}
		if (!Wc({
			name: e.name,
			type: e.type
		}, t.accept)) {
			let n = `File type ${e.type || "unknown"} is not accepted. Accepted types: ${t.accept}`, r = Error(n);
			throw this._safeEmitAttachmentAddError("not-accepted", n, void 0, r, e.type), r;
		}
		let n = this._attachmentAddOperations.start(), r = (e) => {
			if (!this._attachmentAddOperations.accept(n, e.id)) return !1;
			let t = this._attachments.findIndex((t) => t.id === e.id);
			return this._attachments = t === -1 ? [...this._attachments, e] : [
				...this._attachments.slice(0, t),
				e,
				...this._attachments.slice(t + 1)
			], this._notifySubscribers(), !0;
		}, i;
		try {
			await Xc(t.add({ file: e }), (e) => (i = e, r(e)));
		} catch (t) {
			if (this._attachmentAddOperations.isCancelled(n)) return;
			throw i && r({
				...i,
				status: {
					type: "incomplete",
					reason: "error",
					message: t instanceof Error ? t.message : String(t)
				}
			}), this._safeEmitAttachmentAddError("adapter-error", t instanceof Error ? t.message : String(t), i?.id, t instanceof Error ? t : void 0, i?.contentType || e.type), t;
		} finally {
			this._attachmentAddOperations.finish(n);
		}
		this._attachmentAddOperations.isCancelled(n) || (i?.status.type === "incomplete" && i.status.reason === "error" ? this._safeEmitAttachmentAddError("adapter-error", i.status.message ?? "Attachment upload did not complete successfully.", i.id, void 0, i.contentType || e.type) : this._notifyEventSubscribers("attachmentAdd", { ...i?.contentType ? { contentType: i.contentType } : e.type ? { contentType: e.type } : void 0 }));
	}
	_safeEmitAttachmentAddError(e, t, n, r, i) {
		try {
			this._notifyEventSubscribers("attachmentAddError", {
				reason: e,
				message: t,
				...n !== void 0 && { attachmentId: n },
				...r !== void 0 && { error: r },
				...i ? { contentType: i } : void 0
			});
		} catch (e) {
			console.error("[assistant-ui] attachmentAddError subscriber threw:", e);
		}
	}
	async removeAttachment(e) {
		let t = this._attachments.findIndex((t) => t.id === e);
		if (t === -1) throw Error("Attachment not found");
		let n = this._attachments[t];
		if (this._cancelAttachmentAdd(e), this._isSending && this._removedDuringSend.add(e), !Jc(n)) {
			let t = this.getAttachmentAdapter();
			if (!t) throw Error("Attachments are not supported");
			try {
				await t.remove(n);
			} catch (t) {
				let n = t instanceof Error ? t.message : String(t);
				throw this._attachments = this._attachments.map((t) => t.id === e && !Jc(t) ? {
					...t,
					status: {
						type: "incomplete",
						reason: "error",
						message: n
					}
				} : t), this._notifySubscribers(), t;
			}
		}
		this._attachments = this._attachments.filter((t) => t.id !== e), this._notifySubscribers();
	}
	_dictation;
	_dictationSession;
	_dictationUnsubscribes = [];
	_dictationBaseText = "";
	_currentInterimText = "";
	_dictationSessionIdCounter = 0;
	_activeDictationSessionId;
	_isCleaningDictation = !1;
	get dictation() {
		return this._dictation;
	}
	_isActiveSession(e, t) {
		return this._activeDictationSessionId === e && this._dictationSession === t;
	}
	startDictation() {
		let e = this.getDictationAdapter();
		if (!e) throw Error("Dictation adapter not configured");
		let t = this._dictationSession !== void 0;
		if (this._dictationSession) {
			let e = this._dictationSession;
			this._cleanupDictation({ notify: !1 }), this._stopDictationSession(e);
		}
		let n = e.disableInputDuringDictation ?? !1;
		this._dictationBaseText = this._text, this._currentInterimText = "";
		let r;
		try {
			r = e.listen();
		} catch (e) {
			if (t) try {
				this._notifySubscribers();
			} catch (e) {
				console.error("[assistant-ui] Dictation replacement rollback notification threw", e);
			}
			throw e;
		}
		this._dictationSession = r;
		let i = ++this._dictationSessionIdCounter;
		this._activeDictationSessionId = i, this._dictation = {
			status: r.status,
			inputDisabled: n
		}, this._notifySubscribers();
		let a = r.onSpeech((e) => {
			if (!this._isActiveSession(i, r)) return;
			let t = e.isFinal !== !1, n = this._dictationBaseText && !this._dictationBaseText.endsWith(" ") && e.transcript ? " " : "";
			if (t) {
				if (this._dictationBaseText = this._dictationBaseText + n + e.transcript, this._currentInterimText = "", this._text = this._dictationBaseText, this._dictation) {
					let { transcript: e, ...t } = this._dictation;
					this._dictation = t;
				}
				this._notifySubscribers();
			} else this._currentInterimText = n + e.transcript, this._text = this._dictationBaseText + this._currentInterimText, this._dictation &&= {
				...this._dictation,
				transcript: e.transcript
			}, this._notifySubscribers();
		});
		this._dictationUnsubscribes.push(a);
		let o = r.onSpeechStart(() => {
			this._isActiveSession(i, r) && (this._dictation = {
				status: { type: "running" },
				inputDisabled: n,
				...this._dictation?.transcript && { transcript: this._dictation.transcript }
			}, this._notifySubscribers());
		});
		this._dictationUnsubscribes.push(o);
		let s = r.onSpeechEnd(() => {
			this._cleanupDictation({ sessionId: i });
		});
		this._dictationUnsubscribes.push(s);
		let c = setInterval(() => {
			this._isActiveSession(i, r) && r.status.type === "ended" && this._cleanupDictation({ sessionId: i });
		}, 100);
		this._dictationUnsubscribes.push(() => clearInterval(c));
	}
	stopDictation() {
		if (!this._dictationSession) return;
		let e = this._dictationSession, t = this._activeDictationSessionId;
		this._stopDictationSession(e, () => this._cleanupDictation({ sessionId: t }));
	}
	_stopDictationSession(e, t = () => {}) {
		let n;
		try {
			n = e.stop();
		} catch (e) {
			console.error("[assistant-ui] Dictation session stop threw", e), t();
			return;
		}
		n.then(t, (e) => {
			console.error("[assistant-ui] Dictation session stop rejected", e), t();
		});
	}
	_cleanupDictation(e) {
		if (e?.sessionId !== void 0 && e.sessionId !== this._activeDictationSessionId || this._isCleaningDictation) return;
		this._isCleaningDictation = !0;
		let t = (e) => {
			try {
				e();
			} catch (e) {
				console.error("[assistant-ui] Dictation cleanup threw", e);
			}
		};
		try {
			let n = this._dictationUnsubscribes;
			this._dictationUnsubscribes = [], this._dictationSession = void 0, this._activeDictationSessionId = void 0, this._dictation = void 0, this._dictationBaseText = "", this._currentInterimText = "";
			for (let e of n) t(e);
			e?.notify !== !1 && t(() => this._notifySubscribers());
		} finally {
			this._isCleaningDictation = !1;
		}
	}
	_eventSubscribers = /* @__PURE__ */ new Map();
	_notifyEventSubscribers(e, t) {
		let n = this._eventSubscribers.get(e);
		n && _n(n, t, `Composer runtime "${e}"`);
	}
	unstable_on(e, t) {
		let n = t, r = this._eventSubscribers.get(e);
		return r || (r = /* @__PURE__ */ new Set(), this._eventSubscribers.set(e, r)), r.add(n), () => {
			this._eventSubscribers.get(e)?.delete(n);
		};
	}
}, Qc = (e) => e.capabilities?.cancel ? gc(e) : !1, $c = class extends Zc {
	get canCancel() {
		return Qc(this.runtime);
	}
	get canSend() {
		return !this.isEmpty && !this.runtime.isSendDisabled && !this.runtime.voice && !this._isSending;
	}
	_queueCache;
	get queue() {
		let e = this.runtime.getSteerQueueItems?.() ?? Hc, t = this.runtime.getQueueItems?.() ?? Hc, n = this._queueCache;
		if (n && n.steer === e && n.queue === t) return n.flat;
		let r = e.length === 0 ? t : t.length === 0 ? e : [...e, ...t];
		return this._queueCache = {
			steer: e,
			queue: t,
			flat: r
		}, r;
	}
	moveQueueItem(e, t) {
		this.runtime.moveQueueItem?.(e, t);
	}
	removeQueueItem(e) {
		this.runtime.removeQueueItem?.(e);
	}
	getAttachmentAdapter() {
		return this.runtime.adapters?.attachments;
	}
	getDictationAdapter() {
		return this.runtime.adapters?.dictation;
	}
	runtime;
	constructor(e) {
		super(), this.runtime = e, this.connect();
	}
	connect() {
		let e = !1, t = this.runtime.isSendDisabled, n = this.runtime.voice !== void 0, r = this.queue;
		return this.runtime.subscribe(() => {
			let i = !1, a = this.canCancel;
			e !== a && (e = a, i = !0), t !== this.runtime.isSendDisabled && (t = this.runtime.isSendDisabled, i = !0);
			let o = this.runtime.voice !== void 0;
			n !== o && (n = o, i = !0), r !== this.queue && (r = this.queue, i = !0), i && this._notifySubscribers();
		});
	}
	async handleSend(e, t) {
		return this.runtime.append({
			...e,
			parentId: this.runtime.messages.at(-1)?.id ?? null,
			sourceId: null,
			startRun: t?.startRun,
			steer: t?.steer
		});
	}
	async handleCancel() {
		this.runtime.cancelRun();
	}
}, el = class extends Zc {
	get canCancel() {
		return !0;
	}
	get canSend() {
		return !this.isEmpty && !this.runtime.voice && !this._isSending;
	}
	getAttachmentAdapter() {
		return this.runtime.adapters?.attachments;
	}
	getDictationAdapter() {
		return this.runtime.adapters?.dictation;
	}
	_nonTextPassthrough;
	_parentId;
	_sourceId;
	runtime;
	endEditCallback;
	constructor(e, t, { parentId: n, message: r }) {
		super(), this.runtime = e;
		let i = e.voice !== void 0, a = e.subscribe(() => {
			let t = e.voice !== void 0;
			t !== i && (i = t, this._notifySubscribers());
		});
		this.endEditCallback = () => {
			a(), t();
		}, this._parentId = n, this._sourceId = r.id, this.setText(ic(r)), this.setRole(r.role);
		let o;
		r.role === "user" ? (o = [...r.attachments ?? [], ...Kc(r.content)], this._nonTextPassthrough = []) : (o = r.attachments ?? [], this._nonTextPassthrough = r.content.filter((e) => e.type !== "text")), this.setAttachments(o), this.setRunConfig({ ...e.composer.runConfig });
	}
	get parentId() {
		return this._parentId;
	}
	get sourceId() {
		return this._sourceId;
	}
	async handleSend(e, t) {
		let n = this._nonTextPassthrough.length > 0 ? [...e.content, ...this._nonTextPassthrough] : e.content, r = this.runtime.append({
			...e,
			content: n,
			parentId: this._parentId,
			sourceId: this._sourceId,
			startRun: t?.startRun
		});
		return this.handleCancel(), r;
	}
	handleCancel() {
		this.endEditCallback(), this._notifySubscribers();
	}
}, tl = class extends fi {
	_isInitialized = !1;
	repository = new Vc();
	_voiceMessages = [];
	_voiceGeneration = 0;
	_cachedMergedMessages = null;
	_cachedVoiceGeneration = -1;
	_cachedMergedBase = null;
	_markVoiceMessagesDirty() {
		this._voiceGeneration++, this._cachedMergedMessages = null;
	}
	_getBaseMessages() {
		return this.repository.getMessages();
	}
	_commitVoiceMessage(e) {}
	get messages() {
		if (this._voiceMessages.length === 0) return this._getBaseMessages();
		let e = this._getBaseMessages();
		if (this._cachedVoiceGeneration !== this._voiceGeneration || this._cachedMergedBase !== e) {
			let t = new Set(e.map((e) => e.id));
			this._cachedMergedMessages = [...e, ...this._voiceMessages.filter((e) => !t.has(e.id))], this._cachedVoiceGeneration = this._voiceGeneration, this._cachedMergedBase = e;
		}
		return this._cachedMergedMessages;
	}
	get state() {
		let e;
		for (let t of this.messages) t.role === "assistant" && (e = t);
		return e?.metadata.unstable_state ?? null;
	}
	composer = new $c(this);
	_contextProvider;
	constructor(e) {
		super(), this._contextProvider = e;
	}
	getModelContext() {
		return this._contextProvider.getModelContext();
	}
	enrichAppendMetadata(e, t = e.parentId) {
		if (e.role !== "user") return e;
		let n = this.messages, r = t === null ? -1 : n.findIndex((e) => e.id === t), i = ns(this.getModelContext().unstable_composerMetadata, n.slice(0, r + 1));
		return i ? {
			...e,
			metadata: {
				...e.metadata,
				custom: {
					...e.metadata?.custom,
					...i
				}
			}
		} : e;
	}
	_editComposers = /* @__PURE__ */ new Map();
	getEditComposer(e) {
		return this._editComposers.get(e);
	}
	_isVoiceMessage(e) {
		return e !== null && this._voiceMessages.some((t) => t.id === e);
	}
	_resolveAppendParent(e) {
		return this._isVoiceMessage(e) ? this._getBaseMessages().at(-1)?.id ?? null : e;
	}
	beginEdit(e) {
		if (this.voice) throw Error("Cannot edit a message while a voice session is connected");
		if (this._isVoiceMessage(e)) throw Error("Voice transcript messages cannot be edited");
		if (this._editComposers.has(e)) throw Error("Edit already in progress");
		this._editComposers.set(e, new el(this, () => this._editComposers.delete(e), this.repository.getMessage(e))), this._notifySubscribers();
	}
	getMessageById(e) {
		try {
			return this.repository.getMessage(e);
		} catch {
			let t = this.repository.getMessages(), n = this._voiceMessages.findIndex((t) => t.id === e);
			return n === -1 ? void 0 : {
				parentId: n > 0 ? this._voiceMessages[n - 1].id : t.at(-1)?.id ?? null,
				message: this._voiceMessages[n],
				index: t.length + n
			};
		}
	}
	getBranches(e) {
		return this._voiceMessages.some((t) => t.id === e) ? [] : this.repository.getBranches(e);
	}
	switchToBranch(e) {
		this.repository.switchToBranch(e), this._notifySubscribers();
	}
	_notifyEventSubscribers(e, t) {
		let n = this._eventSubscribers.get(e);
		n && _n(n, t, `Thread runtime "${e}"`);
	}
	_notifyToolApprovalAnswered(e, t, n, r) {
		this._notifyEventSubscribers("toolApprovalAnswered", {
			messageId: e,
			toolCallId: t,
			toolName: n,
			approved: r
		});
	}
	submitFeedback({ messageId: e, type: t, comment: n }) {
		let r = this.adapters?.feedback, i = this.getMessageById(e);
		if (!i) throw Error(`Message not found: ${e}`);
		let { message: a, parentId: o } = i, s = n?.trim(), c = {
			type: t,
			...s ? { comment: s } : void 0
		};
		if (r?.submit({
			message: a,
			...c
		}), a.role === "assistant") {
			let t = {
				...a,
				metadata: {
					...a.metadata,
					submittedFeedback: c
				}
			}, n = this._voiceMessages.findIndex((t) => t.id === e);
			n === -1 ? this.repository.addOrUpdateMessage(o, t) : (this._voiceMessages[n] = t, this._currentAssistantMsg === a && (this._currentAssistantMsg = t), this._markVoiceMessagesDirty());
		}
		this._notifySubscribers();
	}
	_stopSpeaking;
	speech;
	speak(e) {
		let t = this.adapters?.speech;
		if (!t) throw Error("Speech adapter not configured");
		let n = this.getMessageById(e);
		if (!n) throw Error(`Message not found: ${e}`);
		let { message: r } = n, i = this._stopSpeaking, a;
		try {
			i?.(), a = t.speak(ic(r));
		} catch (e) {
			if (i && !this._stopSpeaking) try {
				this._notifySubscribers();
			} catch (e) {
				console.error("[assistant-ui] Speech rollback notification threw", e);
			}
			throw e;
		}
		let o, s = () => {
			this._stopSpeaking = void 0, this.speech = void 0;
			let e = o;
			o = void 0, e?.();
		}, c = () => {
			if (this._stopSpeaking === c) try {
				s();
			} finally {
				a.cancel();
			}
		}, l = () => {
			this._stopSpeaking === c && (a.status.type === "ended" ? li([s, () => this._notifySubscribers()]) : (this.speech = {
				messageId: e,
				status: a.status
			}, this._notifySubscribers()));
		};
		this._stopSpeaking = c;
		try {
			if (o = a.subscribe(l), this._stopSpeaking !== c) {
				o();
				return;
			}
			l();
		} catch (e) {
			if (this._stopSpeaking === c) try {
				li([c, () => this._notifySubscribers()]);
			} catch (e) {
				console.error("[assistant-ui] Speech rollback cleanup threw", e);
			}
			throw e;
		}
	}
	stopSpeaking() {
		if (!this._stopSpeaking) throw Error("No message is being spoken");
		li([this._stopSpeaking, () => this._notifySubscribers()]);
	}
	_voiceSession;
	_voiceUnsubs = [];
	voice;
	_voiceVolume = 0;
	_voiceVolumeSubscribers = /* @__PURE__ */ new Set();
	getVoiceVolume = () => this._voiceVolume;
	subscribeVoiceVolume = (e) => (this._voiceVolumeSubscribers.add(e), () => this._voiceVolumeSubscribers.delete(e));
	_onVoiceConnected() {}
	_onVoiceDisconnected() {}
	_isRunActive() {
		if (this.isRunning) return !0;
		let e = this._getBaseMessages().at(-1);
		return e?.role === "assistant" && (e.status.type === "running" || e.status.type === "requires-action");
	}
	connectVoice() {
		let e = this.adapters?.voice;
		if (!e) throw Error("Voice adapter not configured");
		if (this._isRunActive()) throw Error("Cannot start a voice session while a run is in progress or paused on a pending tool action");
		let t = this._voiceSession !== void 0;
		try {
			this._disconnectVoice(!1);
		} catch (e) {
			console.error("[assistant-ui] Voice cleanup threw before reconnect", e);
		}
		let n;
		try {
			n = e.connect({});
		} catch (e) {
			throw t && this._voiceSession === void 0 && this._onVoiceDisconnected(), e;
		}
		this._voiceSession = n;
		let r = [];
		this._voiceUnsubs = r;
		let i = () => {
			if (this._voiceSession === n && this._voiceUnsubs === r) return !1;
			try {
				li(r.splice(0));
			} catch (e) {
				console.error("[assistant-ui] Detached voice setup cleanup threw", e);
			}
			return !0;
		};
		try {
			let e = "listening";
			if (this.voice = {
				status: n.status,
				isMuted: n.isMuted,
				mode: e
			}, this._voiceVolume = 0, this._notifySubscribers(), i() || (r.push(n.onStatusChange((t) => {
				this._voiceSession === n && (t.type === "ended" ? (this._finishVoiceAssistantMessage(), this._voiceSession = void 0, this.voice = void 0, this._onVoiceDisconnected()) : this.voice = {
					status: t,
					isMuted: n.isMuted,
					mode: e
				}, this._notifySubscribers());
			})), i()) || (r.push(n.onModeChange((t) => {
				e = t, this.voice && (this.voice = {
					...this.voice,
					mode: t
				}, this._notifySubscribers());
			})), i()) || (r.push(n.onVolumeChange((e) => {
				this._voiceVolume = e, _n(this._voiceVolumeSubscribers, void 0, "Voice volume");
			})), i())) return;
			r.push(n.onTranscript((e) => {
				this._handleVoiceTranscript(e);
			})), i() || this._onVoiceConnected();
		} catch (e) {
			if (this._voiceSession === n && this._voiceUnsubs === r) {
				try {
					this._disconnectVoice(!1);
				} catch (e) {
					console.error("[assistant-ui] Voice rollback cleanup threw", e);
				}
				t && this._voiceSession === void 0 && this._onVoiceDisconnected();
			} else i();
			throw e;
		}
	}
	_currentAssistantMsg = null;
	_handleVoiceTranscript(e) {
		if (this.ensureInitialized(), e.role === "user") {
			if (this._finishVoiceAssistantMessage(), this._currentAssistantMsg = null, e.isFinal) {
				let t = {
					id: ds(),
					role: "user",
					content: [{
						type: "text",
						text: e.text
					}],
					metadata: {
						modality: "voice",
						custom: {}
					},
					createdAt: /* @__PURE__ */ new Date(),
					status: {
						type: "complete",
						reason: "unknown"
					},
					attachments: []
				};
				this._voiceMessages.push(t), this._commitVoiceMessage(t), this._markVoiceMessagesDirty(), this._notifySubscribers();
			}
		} else {
			let t = e.isFinal ? {
				type: "complete",
				reason: "stop"
			} : { type: "running" };
			if (!this._currentAssistantMsg) this._currentAssistantMsg = {
				id: ds(),
				role: "assistant",
				content: [{
					type: "text",
					text: e.text
				}],
				metadata: {
					unstable_state: this.state,
					unstable_annotations: [],
					unstable_data: [],
					steps: [],
					modality: "voice",
					custom: {}
				},
				status: t,
				createdAt: /* @__PURE__ */ new Date()
			}, this._voiceMessages.push(this._currentAssistantMsg);
			else {
				let n = this._voiceMessages.indexOf(this._currentAssistantMsg);
				if (n === -1) return;
				let r = {
					...this._currentAssistantMsg,
					content: [{
						type: "text",
						text: e.text
					}],
					status: t
				};
				this._voiceMessages[n] = r, this._currentAssistantMsg = r;
			}
			e.isFinal && (this._commitVoiceMessage(this._currentAssistantMsg), this._currentAssistantMsg = null), this._markVoiceMessagesDirty(), this._notifySubscribers();
		}
	}
	_finishVoiceAssistantMessage(e = !0) {
		let t = this._voiceMessages.at(-1);
		if (t?.role === "assistant" && t.status.type === "running") {
			let n = this._voiceMessages.length - 1;
			this._voiceMessages[n] = {
				...t,
				status: {
					type: "complete",
					reason: "stop"
				}
			}, this._commitVoiceMessage(this._voiceMessages[n]), this._currentAssistantMsg = null, this._markVoiceMessagesDirty(), e && this._notifySubscribers();
		}
	}
	disconnectVoice() {
		this._disconnectVoice(!0);
	}
	_disconnectVoice(e) {
		this._finishVoiceAssistantMessage(!1), this._currentAssistantMsg = null;
		let t = this._voiceUnsubs.splice(0);
		this._voiceUnsubs = [];
		let n = this._voiceSession;
		this._voiceSession = void 0, this.voice = void 0, this._voiceVolume = 0;
		let r = this.speech && this._isVoiceMessage(this.speech.messageId) ? this._stopSpeaking : void 0;
		this._voiceMessages = [], this._markVoiceMessagesDirty();
		try {
			li([
				...t,
				...r ? [r] : [],
				...n ? [() => n.disconnect()] : [],
				() => _n(this._voiceVolumeSubscribers, void 0, "Voice volume"),
				() => this._notifySubscribers()
			]);
		} finally {
			e && n && this._voiceSession === void 0 && this._onVoiceDisconnected();
		}
	}
	muteVoice() {
		if (!this._voiceSession) throw Error("No active voice session");
		this._voiceSession.mute(), this.voice = {
			...this.voice,
			isMuted: !0
		}, this._notifySubscribers();
	}
	unmuteVoice() {
		if (!this._voiceSession) throw Error("No active voice session");
		this._voiceSession.unmute(), this.voice = {
			...this.voice,
			isMuted: !1
		}, this._notifySubscribers();
	}
	ensureInitialized() {
		this._isInitialized || (this._isInitialized = !0, this._notifyEventSubscribers("initialize", {}));
	}
	export() {
		return this.repository.export();
	}
	import(e) {
		this.ensureInitialized(), this.repository.clear(), this.repository.import(e), this._notifySubscribers();
	}
	reset(e) {
		this.import(Rc.fromArray(e ?? []));
	}
	_eventSubscribers = /* @__PURE__ */ new Map();
	unstable_on(e, t) {
		let n = t;
		if (e === "modelContextUpdate") return this._contextProvider.subscribe?.(() => _n([n], {}, `Thread runtime "${e}"`)) ?? (() => {});
		let r = this._eventSubscribers.get(e);
		return r || (r = /* @__PURE__ */ new Set(), this._eventSubscribers.set(e, r)), r.add(n), e === "initialize" && this._isInitialized && queueMicrotask(() => {
			r.has(n) && _n([n], {}, `Thread runtime "${e}"`);
		}), () => {
			this._eventSubscribers.get(e)?.delete(n);
		};
	}
}, nl = Symbol.for("assistant-stream.tool-execution-id"), rl = (e) => {
	try {
		return JSON.parse(e), !0;
	} catch {
		return !1;
	}
}, il = (e) => {
	try {
		return JSON.parse(e);
	} catch {
		return;
	}
}, al = (e, t) => {
	let n = il(e), r = il(t);
	return n === void 0 || r === void 0 ? !1 : Ra(n, r);
}, ol = (e) => e[nl], sl = class {
	_getTools;
	_callbacks;
	_isClientToolCall;
	_entries = /* @__PURE__ */ new Map();
	_humanInput = /* @__PURE__ */ new Map();
	_executing = /* @__PURE__ */ new Set();
	_discardedToolCallIds = /* @__PURE__ */ new Set();
	_settledResolvers = [];
	_statuses = /* @__PURE__ */ new Map();
	_ac = new AbortController();
	_pendingRestore = !0;
	_lastSnapshot = null;
	_isRunning = !1;
	_controller;
	_pipelineDead = !1;
	_pipelineRestartUsed = !1;
	constructor(e, t, n) {
		this._getTools = e, this._callbacks = t, this._isClientToolCall = n, this._initPipeline();
	}
	_initPipeline() {
		let [e, t] = so();
		this._controller = t;
		let n = Uo(() => this._getWrappedTools(), () => this._ac.signal, (e, t, n) => this._onHumanInput(e, t, n), {
			onExecutionStart: (e, t, n) => this._onExecutionStart(e, n),
			onExecutionEnd: (e, t, n) => this._onExecutionEnd(e, n)
		});
		e.pipeThrough(n).pipeThrough(new uo()).pipeTo(new WritableStream({ write: (e) => {
			try {
				if (e.type !== "result") return;
				this._handleResultChunk(e);
			} catch (e) {
				console.error("[ToolInvocationTracker] result chunk handling failed", e);
			}
		} })).catch((e) => {
			console.error("[ToolInvocationTracker] stream pipeline failed; will attempt single restart on next setState", e), this._pipelineDead = !0;
		});
	}
	setState(e) {
		try {
			if (this._pipelineDead) {
				if (this._pipelineRestartUsed) return;
				this._pipelineRestartUsed = !0, this._pipelineDead = !1, this._demoteEntriesToRestored(), this._executing.clear(), this._ac = new AbortController(), this._initPipeline();
			}
			if (this._lastSnapshot && this._lastSnapshot.messages === e.messages && this._lastSnapshot.isRunning === e.isRunning && this._lastSnapshot.isLoading === e.isLoading) return;
			e.isLoading === !0 && (this._pendingRestore = !0);
			let t = this._isRunning;
			this._isRunning = e.isRunning;
			try {
				this._processMessages(e.messages);
			} catch (e) {
				throw this._isRunning = t, e;
			}
			this._lastSnapshot = e, this._pendingRestore = !1;
		} catch (e) {
			console.error("[ToolInvocationTracker] setState failed; snapshot dropped", e);
		}
	}
	reset() {
		try {
			this._pendingRestore = !0, this._entries.clear(), this._discardedToolCallIds.clear(), this._lastSnapshot = null, this.abort(), this._statuses.size > 0 && (this._statuses = /* @__PURE__ */ new Map(), this._invokeOnStatusesChange());
		} catch (e) {
			console.error("[ToolInvocationTracker] reset failed", e);
		}
	}
	abort(e) {
		try {
			if (this._humanInput.forEach(({ reject: e }) => {
				try {
					e(/* @__PURE__ */ Error("Tool execution aborted"));
				} catch {}
			}), this._humanInput.clear(), e?.discardPending) for (let [e, t] of this._entries) t.controller && (t.argsComplete || t.hasResult || (this._discardedToolCallIds.add(e), t.skipExecute = !0));
			if (this._ac.abort(), this._ac = new AbortController(), this._executing.size === 0) return Promise.resolve();
			let t = new Set(this._executing);
			return new Promise((e) => {
				this._settledResolvers.push({
					executionIds: t,
					resolve: e
				});
			});
		} catch (e) {
			return console.error("[ToolInvocationTracker] abort failed", e), Promise.resolve();
		}
	}
	resume(e, t) {
		try {
			let n = this._humanInput.get(e);
			return n ? (this._humanInput.delete(e), this._setStatus(e, { type: "executing" }), n.resolve(t), !0) : !1;
		} catch (e) {
			return console.error("[ToolInvocationTracker] resume failed", e), !1;
		}
	}
	getStatuses() {
		return this._statuses;
	}
	_getWrappedTools() {
		let e = this._getTools();
		if (e) return Object.fromEntries(Object.entries(e).map(([e, t]) => {
			let n = t.execute, r = t.streamCall;
			return n === void 0 && r === void 0 ? [e, t] : [e, {
				...t,
				...n !== void 0 && { execute: (...[e, t]) => {
					let r = ol(t), i = this._captureExecution(t.toolCallId, r);
					return !i || i.skipExecute ? new Promise(() => {}) : n(e, t);
				} },
				...r !== void 0 && { streamCall: (...[e, t]) => {
					let n = ol(t);
					if (this._captureExecution(t.toolCallId, n)) return r(e, t);
				} }
			}];
		}));
	}
	_captureExecution(e, t) {
		if (t === void 0) return;
		let n = this._entries.get(e);
		if (n?.controller) return n.executionId === void 0 && (n.executionId = t), n.executionId === t ? n : void 0;
	}
	_onHumanInput(e, t, n) {
		return new Promise((r, i) => {
			let a = this._entries.get(e);
			if (!a?.controller || a.executionId !== n) {
				i(/* @__PURE__ */ Error("Tool execution aborted"));
				return;
			}
			let o = this._humanInput.get(e);
			if (o) try {
				o.reject(/* @__PURE__ */ Error("Human input request was superseded by a new request"));
			} catch {}
			this._humanInput.set(e, {
				executionId: n,
				resolve: r,
				reject: i
			}), this._setStatus(e, {
				type: "interrupt",
				payload: {
					type: "human",
					payload: t
				}
			});
		});
	}
	_onExecutionStart(e, t) {
		this._captureExecution(e, t) && (this._entries.get(e).skipExecute || (this._executing.add(t), this._humanInput.get(e)?.executionId !== t && this._setStatus(e, { type: "executing" })));
	}
	_onExecutionEnd(e, t) {
		if (t === void 0 || !this._executing.delete(t)) return;
		this._entries.get(e)?.executionId === t && this._deleteStatus(e);
		let n = [];
		this._settledResolvers.forEach(({ executionIds: e, resolve: t }) => {
			if ([...e].some((e) => this._executing.has(e))) {
				n.push({
					executionIds: e,
					resolve: t
				});
				return;
			}
			try {
				t();
			} catch {}
		}), this._settledResolvers.length = 0, this._settledResolvers.push(...n);
	}
	_handleResultChunk(e) {
		let t = e.meta.toolCallId, n = ol(e), r = this._entries.get(t);
		r && r.executionId === n && (r?.hasResult || r.skipExecute || this._invokeOnResult({
			type: "add-tool-result",
			toolCallId: t,
			toolName: e.meta.toolName,
			result: e.result,
			isError: e.isError,
			...e.artifact !== void 0 && { artifact: e.artifact },
			...e.modelContent !== void 0 && { modelContent: e.modelContent }
		}));
	}
	_invokeOnResult(e) {
		try {
			this._callbacks.onResult(e);
		} catch (e) {
			console.error("[ToolInvocationTracker] onResult callback threw; result dropped", e);
		}
	}
	_invokeOnStatusesChange() {
		try {
			this._callbacks.onStatusesChange(this._statuses);
		} catch (e) {
			console.error("[ToolInvocationTracker] onStatusesChange callback threw; status change not propagated", e);
		}
	}
	_setStatus(e, t) {
		let n = new Map(this._statuses);
		n.set(e, t), this._statuses = n, this._invokeOnStatusesChange();
	}
	_deleteStatus(e) {
		if (!this._statuses.has(e)) return;
		let t = new Map(this._statuses);
		t.delete(e), this._statuses = t, this._invokeOnStatusesChange();
	}
	_warnProviderOwnedSkip(e, t) {}
	_shouldCloseArgsStream({ argsText: e, hasResult: t, clientOwned: n }) {
		return t ? !0 : rl(e) ? n || !this._isRunning : !1;
	}
	_startActiveEntry(e, t, n, r) {
		let i = {
			toolName: t,
			controller: this._controller.addToolCallPart({
				toolName: t,
				toolCallId: e
			}),
			argsText: "",
			hasResult: !1,
			skipExecute: n,
			argsComplete: !1,
			clientOwned: r
		};
		return this._entries.set(e, i), i;
	}
	_demoteEntriesToRestored() {
		for (let [e, t] of this._entries) if (t.controller) {
			if (!t.argsComplete && !t.hasResult) {
				this._entries.delete(e);
				continue;
			}
			this._entries.set(e, {
				toolName: t.toolName,
				argsText: t.argsText,
				hasResult: t.hasResult
			});
		}
	}
	_processArgsText(e, t) {
		if (!e.controller) return;
		let n = t.result !== void 0;
		if (t.argsText !== e.argsText) {
			let r = !0;
			if (e.argsComplete) al(e.argsText, t.argsText) && (e.argsText = t.argsText), r = !1;
			else if (!t.argsText.startsWith(e.argsText)) {
				if (rl(e.argsText) && rl(t.argsText) && al(e.argsText, t.argsText)) {
					let i = this._shouldCloseArgsStream({
						argsText: t.argsText,
						hasResult: n,
						clientOwned: e.clientOwned
					});
					i && e.controller.argsText.close(), e.argsText = t.argsText, e.argsComplete = i, r = !1;
				} else r = !1;
			}
			if (r && e.controller) {
				let r = t.argsText.slice(e.argsText.length);
				e.controller.argsText.append(r);
				let i = this._shouldCloseArgsStream({
					argsText: t.argsText,
					hasResult: n,
					clientOwned: e.clientOwned
				});
				i && e.controller.argsText.close(), e.argsText = t.argsText, e.argsComplete = i;
			}
		}
		!e.argsComplete && e.controller && this._shouldCloseArgsStream({
			argsText: e.argsText,
			hasResult: n,
			clientOwned: e.clientOwned
		}) && (e.controller.argsText.close(), e.argsComplete = !0);
	}
	_processMessages(e) {
		let t = this._pendingRestore;
		for (let { part: n } of Uc(e)) {
			let e = this._entries.get(n.toolCallId);
			if (t) {
				e?.controller || this._entries.set(n.toolCallId, {
					toolName: n.toolName,
					argsText: n.argsText,
					hasResult: n.result !== void 0
				});
				continue;
			}
			let r = e;
			if (n.result !== void 0 && this._discardedToolCallIds.delete(n.toolCallId), r && !r.controller) {
				if (r.hasResult || (n.argsText === r.argsText || rl(r.argsText) && rl(n.argsText) && al(r.argsText, n.argsText)) && n.result === void 0) continue;
				this._entries.delete(n.toolCallId), r = void 0;
			}
			if (!r) {
				let e = this._isClientToolCall?.(n), t = n.result === void 0 && e === !1;
				t && this._warnProviderOwnedSkip(n.toolName, n.toolCallId), r = this._startActiveEntry(n.toolCallId, n.toolName, n.result !== void 0 || t || this._discardedToolCallIds.has(n.toolCallId), e === !0);
			}
			if (n.approval !== void 0 && (r.skipExecute = !0), this._processArgsText(r, n), n.result !== void 0 && !r.hasResult) {
				let { controller: e } = r;
				if (!e) continue;
				r.hasResult = !0, r.argsComplete = !0, e.setResponse(new Va({
					result: n.result,
					artifact: n.artifact,
					isError: n.isError,
					...n.modelContent === void 0 ? {} : { modelContent: n.modelContent }
				})), e.close();
			}
		}
	}
}, cl = Object.freeze([]), ll = (e, t) => {
	Promise.resolve(t).catch((t) => {
		console.error(`[ExternalStoreThreadRuntimeCore] ${e} callback rejected`, t);
	});
}, ul = (e, t) => e && t[t.length - 1]?.role !== "assistant", dl = class extends tl {
	_capabilities = {
		switchToBranch: !1,
		switchBranchDuringRun: !1,
		edit: !1,
		delete: !1,
		reload: !1,
		refetchThread: !1,
		cancel: !1,
		unstable_copy: !1,
		speech: !1,
		dictation: !1,
		voice: !1,
		attachments: !1,
		feedback: !1,
		queue: !1
	};
	get capabilities() {
		return this._capabilities;
	}
	_messages;
	isDisabled;
	isSendDisabled;
	get isLoading() {
		return this._store.isLoading ?? !1;
	}
	get isRunning() {
		return this._hasExecutingTools(this._store) ? !0 : this._store.isRunning;
	}
	_getBaseMessages() {
		return this._messages;
	}
	get state() {
		return this._store.state ?? super.state;
	}
	get adapters() {
		return this._store.adapters;
	}
	get unstable_refetchThread() {
		if (this._store.onRefetchThread) return () => this._store.onRefetchThread();
	}
	suggestions = [];
	extras = void 0;
	_converter = new Os();
	_pendingDeleteEvictions = /* @__PURE__ */ new Set();
	_optimistic = null;
	_store;
	_getInitializePromise;
	__internal_setGetInitializePromise(e) {
		this._getInitializePromise = e;
	}
	_transformedQueue;
	_toolInvocations = null;
	_toolStatuses = /* @__PURE__ */ new Map();
	_effectiveIsRunning = !1;
	_inTrackerUpdate = !1;
	_pendingRunningRefresh = !1;
	_runTrackerUpdate(e) {
		this._inTrackerUpdate = !0;
		try {
			e();
		} finally {
			this._inTrackerUpdate = !1;
		}
		this._pendingRunningRefresh && (this._pendingRunningRefresh = !1, this._refreshEffectiveIsRunning());
	}
	_refreshEffectiveIsRunning() {
		let e = this._getEffectiveIsRunning(this._store);
		this._effectiveIsRunning !== e && (this._effectiveIsRunning = e, this._notifyEventSubscribers(e ? "runStart" : "runEnd", {}), this._notifySubscribers());
	}
	_hasExecutingTools(e) {
		if (e.unstable_enableToolInvocations !== !0 || this._toolInvocations === null) return !1;
		for (let e of this._toolStatuses.values()) if (e.type === "executing") return !0;
		return !1;
	}
	_getEffectiveIsRunning(e) {
		return (e.isRunning ?? !1) || this._hasExecutingTools(e);
	}
	beginEdit(e) {
		if (!this._store.onEdit) throw Error("Runtime does not support editing.");
		super.beginEdit(e);
	}
	constructor(e, t) {
		super(e), this.__internal_setAdapter(t);
	}
	__internal_setAdapter(e) {
		this._store !== e && this._updateStoreSnapshot(e);
	}
	_updateStoreSnapshot(e) {
		let t = this._effectiveIsRunning;
		this.isDisabled = e.isDisabled ?? !1, this.isSendDisabled = e.isSendDisabled ?? !1;
		let n = this._store;
		this._store = e;
		let r = this._getEffectiveIsRunning(e), i = e.unstable_messageRepositoryInstance, a = i !== void 0 && i !== this.repository;
		a && (this.repository = i, this._pendingDeleteEvictions.clear()), n?.queue !== e.queue && (this._transformedQueue = void 0, e.queue?.__internal_setDispatchTransform?.((e) => {
			let t = this.messages.at(-1)?.id ?? null;
			return this.enrichAppendMetadata({
				...e,
				parentId: t
			}, t);
		}), e.queue?.__internal_setDispatchTransform && (this._transformedQueue = e.queue)), this.extras !== e.extras && (this.extras = e.extras);
		let o = e.suggestions ?? cl;
		Cr(this.suggestions, o) || (this.suggestions = o);
		let s = {
			switchToBranch: this._store.setMessages !== void 0,
			switchBranchDuringRun: !1,
			edit: this._store.onEdit !== void 0,
			delete: this._store.onDelete !== void 0 || this._store.setMessages !== void 0,
			reload: this._store.onReload !== void 0,
			refetchThread: this._store.onRefetchThread !== void 0,
			cancel: this._store.onCancel !== void 0,
			speech: this._store.adapters?.speech !== void 0,
			dictation: this._store.adapters?.dictation !== void 0,
			voice: this._store.adapters?.voice !== void 0,
			unstable_copy: this._store.unstable_capabilities?.copy !== !1,
			attachments: !!this._store.adapters?.attachments,
			feedback: !!this._store.adapters?.feedback,
			queue: this._store.queue !== void 0
		};
		Cr(this._capabilities, s) || (this._capabilities = s);
		let c;
		if (e.messageRepository) {
			if (n && !a && n.isRunning === e.isRunning && n.messageRepository === e.messageRepository && t === r) {
				this._notifySubscribers();
				return;
			}
			let i = e.messageRepository.messages, o = e.messageRepository.headId ?? i.at(-1)?.message.id ?? null;
			if (n && !a && n.messageRepository === e.messageRepository) this.repository.resetHead(o), c = this.repository.getMessages();
			else {
				let e = new Set(i.map(({ message: e }) => e.id));
				for (let { message: e, parentId: t } of i) this.repository.addOrUpdateMessage(t, e);
				for (let { message: t } of this.repository.export().messages) e.has(t.id) || this.repository.deleteMessage(t.id);
				this._pendingDeleteEvictions.clear(), this.repository.resetHead(o), c = this.repository.getMessages();
			}
		} else if (e.messages) {
			if (n) {
				if (n.convertMessage !== e.convertMessage) this._converter = new Os();
				else if (!a && n.isRunning === e.isRunning && n.messages === e.messages && t === r) {
					this._notifySubscribers();
					return;
				}
			}
			c = e.convertMessage ? this._converter.convertMessages(e.messages, (t, n, i) => {
				if (!e.convertMessage) return n;
				let a = i === (e.messages?.length ?? 0) - 1, o = `${us}${i}`;
				if (t && (t.role !== "assistant" || !ws(t.status) || t.status === Ds(t.content, a, r))) {
					if (t.id.startsWith("__external_store_fallback_") && t.id !== o) {
						let e = {
							...t,
							id: o
						};
						return cs(e, n), e;
					}
					return t;
				}
				let s = e.convertMessage(n, i), c = ms(s, o, Ds(s.content, a, r));
				return cs(c, n), c;
			}) : e.messages;
			let i = /* @__PURE__ */ new Set(), o = [];
			for (let e = c.length - 1; e >= 0; e--) {
				let t = c[e];
				if (i.has(t.id)) {
					console.warn(`ExternalStoreThreadRuntimeCore: duplicate message id "${t.id}" in the provided messages array; keeping the last occurrence.`);
					continue;
				}
				i.add(t.id), o.push(t);
			}
			o.length !== c.length && (c = o.reverse());
			for (let e = 0; e < c.length; e++) {
				let t = c[e], n = c[e - 1];
				this.repository.addOrUpdateMessage(n?.id ?? null, t);
			}
			if (this._pendingDeleteEvictions.size > 0) {
				let e = new Set(c.map((e) => e.id));
				for (let t of this._pendingDeleteEvictions) if (this._pendingDeleteEvictions.delete(t), !e.has(t)) {
					try {
						this.repository.getMessage(t);
					} catch {
						continue;
					}
					this.repository.deleteMessage(t);
				}
			}
		} else throw Error("ExternalStoreAdapter must provide either 'messages' or 'messageRepository'");
		c.length > 0 && this.ensureInitialized(), this._effectiveIsRunning = r, t !== r && (r ? this._notifyEventSubscribers("runStart", {}) : this._notifyEventSubscribers("runEnd", {}));
		let l = null;
		if (ul(r, c)) {
			let e = c.at(-1)?.id ?? null;
			this._optimistic?.parentId !== e && (this._optimistic = {
				id: ds(),
				parentId: e
			}), l = this._optimistic.id, this.repository.addOrUpdateMessage(e, ms({
				role: "assistant",
				content: [],
				metadata: { isOptimistic: !0 }
			}, l, { type: "running" }));
		}
		l === null && (this._optimistic = null), this.repository.resetHead(l ?? c.at(-1)?.id ?? null);
		let u = this.repository.getMessages();
		if ((!this._messages || !ks(this._messages, u)) && (this._messages = u), this._voiceMessages.length > 0) {
			let e = new Set(this._messages.map((e) => e.id)), t = this._voiceMessages.filter((t) => !e.has(t.id));
			t.length !== this._voiceMessages.length && (this._voiceMessages = t, this._markVoiceMessagesDirty());
		}
		a && this._runTrackerUpdate(() => this._toolInvocations?.reset()), this._runTrackerUpdate(() => this._driveToolInvocations()), this._notifySubscribers();
	}
	_driveToolInvocations() {
		if (!this._store.unstable_enableToolInvocations) {
			this._toolInvocations && (this._toolInvocations.reset(), this._toolInvocations = null, this._toolStatuses = /* @__PURE__ */ new Map(), this._store.setToolStatuses?.({}));
			return;
		}
		this._toolInvocations ||= new sl(() => this.getModelContext().tools, {
			onResult: (e) => {
				try {
					let t = this._findMessageIdForToolCall(e.toolCallId);
					if (t === void 0) return;
					ll("onAddToolResult", this._store.onAddToolResult?.({
						messageId: t,
						toolCallId: e.toolCallId,
						toolName: e.toolName,
						result: e.result,
						isError: e.isError,
						...e.artifact !== void 0 && { artifact: e.artifact },
						...e.modelContent !== void 0 && { modelContent: e.modelContent }
					}));
				} catch (e) {
					console.error("[ExternalStoreThreadRuntimeCore] onAddToolResult dispatch failed", e);
				}
			},
			onStatusesChange: (e) => {
				let t = this._hasExecutingTools(this._store);
				this._toolStatuses = e;
				try {
					this._store.setToolStatuses?.(Object.fromEntries(e));
				} finally {
					t !== this._hasExecutingTools(this._store) && (this._inTrackerUpdate ? this._pendingRunningRefresh = !0 : this._updateStoreSnapshot(this._store));
				}
			}
		}, (e) => this._store.unstable_isClientToolCall?.(e)), this._toolInvocations.setState({
			messages: this._messages,
			isRunning: this._getEffectiveIsRunning(this._store),
			...this._store.isLoading !== void 0 && { isLoading: this._store.isLoading }
		});
	}
	_toolCallToMessageId = /* @__PURE__ */ new Map();
	_messagesForToolCallIndex = null;
	_findMessageIdForToolCall(e) {
		if (this._messagesForToolCallIndex !== this._messages) {
			this._toolCallToMessageId.clear();
			for (let { part: e, messageId: t } of Uc(this._messages)) this._toolCallToMessageId.set(e.toolCallId, t);
			this._messagesForToolCallIndex = this._messages;
		}
		return this._toolCallToMessageId.get(e);
	}
	switchToBranch(e) {
		if (!this._store.setMessages) throw Error("Runtime does not support switching branches.");
		if (this._getEffectiveIsRunning(this._store)) return;
		let t = this._store.unstable_onBranchChange, n = t ? this.repository.canonicalHeadId : null;
		this.repository.switchToBranch(e), this._pendingDeleteEvictions.clear(), this.updateMessages(this.repository.getMessages()), t && this._notifyBranchChange(n, t);
	}
	_notifyBranchChange(e, t) {
		let n = this.repository.canonicalHeadId;
		n !== e && t({
			headId: n,
			visibleMessageIds: this.repository.getMessages().map((e) => e.id)
		});
	}
	async append(e) {
		let t = {
			...e,
			parentId: this._resolveAppendParent(e.parentId)
		};
		if (this.voice) throw Error("Cannot send a text message while a voice session is connected");
		if (this._isVoiceMessage(t.sourceId)) throw Error("Voice transcript messages cannot be edited");
		let n = t.sourceId != null || t.parentId !== (this._getBaseMessages().at(-1)?.id ?? null);
		t = !n && this._store.queue && this._store.queue === this._transformedQueue ? t : this.enrichAppendMetadata(t);
		let r = Dc(this);
		this.ensureInitialized();
		let i = this._getInitializePromise?.();
		if (!n && this._store.queue) {
			if (i && await i, !Oc(this, r)) return;
			t.steer ?? this._getEffectiveIsRunning(this._store) ? this._store.queue.steer(t) : this._store.queue.enqueue(t);
			return;
		}
		if (i?.catch(() => {}), (t.startRun ?? t.role === "user") && await this._toolInvocations?.abort({ discardPending: !0 }), Oc(this, r)) {
			if (n) {
				if (!this._store.onEdit) throw Error("Runtime does not support editing messages.");
				this._pendingDeleteEvictions.clear(), await this._store.onEdit(t);
			} else await this._store.onNew(t);
		}
	}
	_commitVoiceMessage(e) {
		this._store.onVoiceTranscript?.(e);
	}
	async deleteMessage(e) {
		if (this._store.onDelete) {
			this.repository.getMessages().some((t) => t.id === e) && this._pendingDeleteEvictions.add(e);
			try {
				await this._store.onDelete(e);
			} catch (t) {
				throw this._pendingDeleteEvictions.delete(e), t;
			}
			return;
		}
		if (!this._store.setMessages) throw Error("Runtime does not support deleting messages.");
		this._getEffectiveIsRunning(this._store) && await this._toolInvocations?.abort();
		let t = this.repository.getMessages();
		if (t.findIndex((t) => t.id === e) === -1) throw Error("Message not found.");
		this._pendingDeleteEvictions.clear(), this.updateMessages(t.filter((t) => t.id !== e)), this._evictDeletedMessage(e);
	}
	_evictDeletedMessage(e) {
		if (!e.startsWith("__external_store_fallback_")) {
			try {
				this.repository.getMessage(e);
			} catch {
				return;
			}
			this.repository.deleteMessage(e), this._publishRepositoryMessages();
		}
	}
	_publishRepositoryMessages() {
		let e = this.repository.getMessages();
		ks(this._messages, e) || (this._messages = e), this._notifySubscribers();
	}
	getQueueItems() {
		return this._store?.queue?.items ?? Hc;
	}
	getSteerQueueItems() {
		return this._store?.queue?.steerItems ?? Hc;
	}
	moveQueueItem(e, t) {
		this._store?.queue?.move(e, t);
	}
	removeQueueItem(e) {
		this._store?.queue?.remove(e);
	}
	async startRun(e) {
		if (!this._store.onReload) throw Error("Runtime does not support reloading messages.");
		if (this.voice) throw Error("Cannot start a run while a voice session is connected");
		if (this._isVoiceMessage(e.sourceId)) throw Error("Voice transcript messages cannot be reloaded");
		this._pendingDeleteEvictions.clear(), await this._toolInvocations?.abort({ discardPending: !0 }), await this._store.onReload(e.parentId, e);
	}
	async resumeRun(e) {
		if (!this._store.onResume) throw Error("Runtime does not support resuming runs.");
		if (this.voice) throw Error("Cannot start a run while a voice session is connected");
		if (this._isVoiceMessage(e.sourceId)) throw Error("Voice transcript messages cannot be reloaded");
		await this._store.onResume(e);
	}
	exportExternalState() {
		if (!this._store.onExportExternalState) throw Error("Runtime does not support exporting external states.");
		return this._store.onExportExternalState();
	}
	importExternalState(e) {
		if (!this._store.onLoadExternalState) throw Error("Runtime does not support importing external states.");
		this._runTrackerUpdate(() => this._toolInvocations?.reset()), this._store.onLoadExternalState(e);
	}
	unstable_notifySessionReset() {
		this._runTrackerUpdate(() => this._toolInvocations?.reset()), this._store.queue?.__internal_notifyCancelled?.();
	}
	cancelRun() {
		if (!this._store.onCancel) throw Error("Runtime does not support cancelling runs.");
		let e = Dc(this);
		this._toolInvocations?.abort({ discardPending: !0 }), this._store.queue?.__internal_notifyCancelled?.(), ll("onCancel", this._store.onCancel()), this.dropEmptyOptimisticHead();
		let t = this.repository.getMessages(), n = t[t.length - 1], r = this._store.setMessages !== void 0 && n?.role === "user" && n.id === t.at(-1)?.id && n.content.every((e) => e.type === "text") ? n : void 0, i;
		if (r) {
			let e = {
				text: ic(r),
				attachments: r.attachments,
				quote: r.metadata.custom.quote
			};
			this.composer.restoreDraft(e) && (this.repository.deleteMessage(r.id), i = {
				id: r.id,
				draft: e
			});
		}
		this._publishRepositoryMessages(), setTimeout(() => {
			if (Oc(this, e)) {
				if (this.dropEmptyOptimisticHead(), i) {
					let e = this.repository.getMessages();
					e.at(-1)?.id === i.id ? this.repository.deleteMessage(i.id) : e.some((e) => e.id === i.id) && this.composer.retractDraft(i.draft);
				}
				this._publishRepositoryMessages(), this.updateMessages(this._messages);
			}
		}, 0);
	}
	dropEmptyOptimisticHead() {
		let e = this.repository.getMessages().at(-1);
		e && e.metadata.isOptimistic && e.content.length === 0 && this.repository.deleteMessage(e.id);
	}
	addToolResult(e) {
		if (!this._store.onAddToolResult) throw Error("Runtime does not support tool results.");
		ll("onAddToolResult", this._store.onAddToolResult(e));
	}
	resumeToolCall(e) {
		if (!(this._toolInvocations?.resume(e.toolCallId, e.payload) ?? !1)) {
			if (this._store.onResumeToolCall) {
				this._store.onResumeToolCall(e);
				return;
			}
			throw Error(`Tool call ${e.toolCallId} is not waiting for resume.`);
		}
	}
	respondToToolApproval(e) {
		if (!this._store.onRespondToToolApproval) throw Error("Runtime does not support tool approvals.");
		let t = this.messages.findLast((t) => t.role === "assistant" && t.content.some((t) => t.type === "tool-call" && t.approval?.id === e.approvalId)), n = t?.content.find((t) => t.type === "tool-call" && t.approval?.id === e.approvalId);
		try {
			return Promise.resolve(this._store.onRespondToToolApproval(e)).then(() => {
				t && n?.type === "tool-call" && this._notifyToolApprovalAnswered(t.id, n.toolCallId, n.toolName, e.approved);
			});
		} catch (e) {
			return Promise.reject(e);
		}
	}
	reset(e) {
		let t = new Vc();
		t.import(Rc.fromArray(e ?? [])), this.updateMessages(t.getMessages());
	}
	import(e) {
		super.import(e), this._store.onImport && this._store.onImport(this.repository.getMessages());
	}
	updateMessages = (e) => {
		this._store.convertMessage === void 0 ? this._store.setMessages?.(e) : this._store.setMessages?.(e.flatMap(ls));
	};
}, fl = (e) => e.adapters?.threadList ?? {}, pl = class extends Ac {
	threads;
	constructor(e) {
		super(), this.threads = new Lc(fl(e), () => new dl(this._contextProvider, e));
	}
	setAdapter(e) {
		this.threads.__internal_setAdapter(fl(e)), this.threads.getMainThreadRuntimeCore().__internal_setAdapter(e);
	}
}, ml = (e) => {
	let t = N(21), { modelContext: n, feedback: r } = is() ?? {}, i;
	bb0: {
		if (!r || e.adapters?.feedback) {
			i = e;
			break bb0;
		}
		let n;
		t[0] !== r || t[1] !== e.adapters ? (n = {
			...e.adapters,
			feedback: r
		}, t[0] = r, t[1] = e.adapters, t[2] = n) : n = t[2];
		let a;
		t[3] !== e || t[4] !== n ? (a = {
			...e,
			adapters: n
		}, t[3] = e, t[4] = n, t[5] = a) : a = t[5], i = a;
	}
	let a = i, o;
	t[6] === a ? o = t[7] : (o = () => new pl(a), t[6] = a, t[7] = o);
	let [s] = Qe(o), c;
	t[8] === s.threads ? c = t[9] : (c = () => () => {
		kc(s.threads.getMainThreadRuntimeCore());
	}, t[8] = s.threads, t[9] = c);
	let l;
	t[10] === s ? l = t[11] : (l = [s], t[10] = s, t[11] = l), R(c, l);
	let u;
	t[12] !== a || t[13] !== s ? (u = () => {
		s.setAdapter(a);
	}, t[12] = a, t[13] = s, t[14] = u) : u = t[14], R(u);
	let d, f;
	t[15] !== n || t[16] !== s ? (d = () => {
		if (n) return s.registerModelContextProvider(n);
	}, f = [n, s], t[15] = n, t[16] = s, t[17] = d, t[18] = f) : (d = t[17], f = t[18]), R(d, f);
	let p;
	return t[19] === s ? p = t[20] : (p = new Tc(s), t[19] = s, t[20] = p), p;
}, hl = (e) => {
	let t = N(6), { id: n, children: r } = e, i = Kr(), a;
	t[0] === n ? a = t[1] : (a = vn({
		message: $r({
			source: "thread",
			query: {
				type: "id",
				id: n
			},
			get: (e) => e.thread.message({ id: n })
		}),
		composer: $r({
			source: "message",
			query: {},
			get: (e) => e.thread.message({ id: n }).composer()
		})
	}), t[0] = n, t[1] = a);
	let o = a, s;
	return t[2] !== i || t[3] !== r || t[4] !== o ? (s = /* @__PURE__ */ (0, H.jsx)(Ta, {
		extends: i,
		config: o,
		children: r
	}), t[2] = i, t[3] = r, t[4] = o, t[5] = s) : s = t[5], s;
}, gl = (e, t) => e.Message === t.Message && e.EditComposer === t.EditComposer && e.UserEditComposer === t.UserEditComposer && e.AssistantEditComposer === t.AssistantEditComposer && e.SystemEditComposer === t.SystemEditComposer && e.UserMessage === t.UserMessage && e.AssistantMessage === t.AssistantMessage && e.SystemMessage === t.SystemMessage, _l = () => null, vl = /* @__PURE__ */ new WeakMap(), yl = (e, t) => {
	let n = vl.get(e);
	return n || (n = new Set(e.map((e) => e.id)), vl.set(e, n)), n.has(t);
}, bl = (e, t, n) => {
	switch (t) {
		case "user": return n ? e.UserEditComposer ?? e.EditComposer ?? e.UserMessage ?? e.Message : e.UserMessage ?? e.Message;
		case "assistant": return n ? e.AssistantEditComposer ?? e.EditComposer ?? e.AssistantMessage ?? e.Message : e.AssistantMessage ?? e.Message;
		case "system": return n ? e.SystemEditComposer ?? e.EditComposer ?? e.SystemMessage ?? e.Message ?? _l : e.SystemMessage ?? e.Message ?? _l;
		default: throw Error(`Unknown message role: ${t}`);
	}
}, xl = (e) => {
	let t = N(6), { components: n } = e, r = B(Dl), i = B(Ol), a;
	t[0] !== n || t[1] !== i || t[2] !== r ? (a = bl(n, r, i), t[0] = n, t[1] = i, t[2] = r, t[3] = a) : a = t[3];
	let o = a, s;
	return t[4] === o ? s = t[5] : (s = /* @__PURE__ */ (0, H.jsx)(o, {}), t[4] = o, t[5] = s), s;
}, Sl = ut((e) => {
	let t = N(5), { index: n, components: r } = e, i;
	t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(xl, { components: r }), t[0] = r, t[1] = i);
	let a;
	return t[2] !== n || t[3] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(js, {
		index: n,
		children: i
	}), t[2] = n, t[3] = i, t[4] = a) : a = t[4], a;
}, (e, t) => e.index === t.index && gl(e.components, t.components));
Sl.displayName = "ThreadPrimitive.MessageByIndex";
var Cl = ut((e) => {
	let t = N(7), { messageId: n, components: r } = e, i;
	if (t[0] === n ? i = t[1] : (i = (e) => yl(e.thread.messages, n), t[0] = n, t[1] = i), !B(i)) return null;
	let a;
	t[2] === r ? a = t[3] : (a = /* @__PURE__ */ (0, H.jsx)(xl, { components: r }), t[2] = r, t[3] = a);
	let o;
	return t[4] !== n || t[5] !== a ? (o = /* @__PURE__ */ (0, H.jsx)(hl, {
		id: n,
		children: a
	}), t[4] = n, t[5] = a, t[6] = o) : o = t[6], o;
}, (e, t) => e.messageId === t.messageId && gl(e.components, t.components));
Cl.displayName = "ThreadPrimitive.Unstable_MessageById";
var wl = ({ children: e }) => {
	let t = B(Tr((e) => e.thread.messages.map((e) => e.id)));
	return tt(() => t.length === 0 ? null : t.map((t, n) => /* @__PURE__ */ (0, H.jsx)(js, {
		index: n,
		children: /* @__PURE__ */ (0, H.jsx)(Oa, {
			getItemState: (e) => e.thread.message({ index: n }).getState(),
			children: (t) => e({ get message() {
				return t();
			} })
		})
	}, t)), [t, e]);
}, Tl = (e) => {
	let t = N(4), { components: n, children: r } = e;
	if (n) {
		let e;
		return t[0] === n ? e = t[1] : (e = /* @__PURE__ */ (0, H.jsx)(wl, { children: () => /* @__PURE__ */ (0, H.jsx)(xl, { components: n }) }), t[0] = n, t[1] = e), e;
	}
	let i;
	return t[2] === r ? i = t[3] : (i = /* @__PURE__ */ (0, H.jsx)(wl, { children: r }), t[2] = r, t[3] = i), i;
};
Tl.displayName = "ThreadPrimitive.Messages";
var El = ut(Tl, (e, t) => e.children || t.children ? e.children === t.children : gl(e.components, t.components));
function Dl(e) {
	return e.message.role;
}
function Ol(e) {
	return e.message.composer.isEditing;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/utils/getMessageQuote.js
var kl = (e) => {
	let t = e.message.metadata;
	if (t && typeof t == "object") return t.custom?.quote;
}, Al = class extends Error {
	componentName;
	constructor(e, t = `Component "${e}" is not in the generative-ui allowlist.`) {
		super(t), this.name = "GenerativeUIRenderError", this.componentName = e;
	}
}, jl = (e) => typeof e == "object" && !!e, Ml = (e) => e == null ? [] : Array.isArray(e) ? e : [e], Nl = (e, t, n, r) => {
	if (e == null) return null;
	if (typeof e == "string") return e;
	if (!jl(e) || !("component" in e) || typeof e.component != "string") return null;
	let { component: i, props: a, children: o, key: s } = e, c = t[i];
	if (!c) {
		if (n) return /* @__PURE__ */ (0, H.jsx)(n, {
			component: i,
			props: a
		}, s ?? r);
		throw new Al(i);
	}
	return ft(c, {
		...a ?? {},
		key: s ?? r
	}, ...Ml(o).map((e, i) => Nl(e, t, n, `${r}/${i}`)));
}, Pl = (e) => {
	let t = N(11), { spec: n, components: r, Fallback: i } = e, a = n?.root, o;
	t[0] === a ? o = t[1] : (o = Ml(a), t[0] = a, t[1] = o);
	let s = o, c;
	if (t[2] !== i || t[3] !== r || t[4] !== s) {
		let e;
		t[6] !== i || t[7] !== r ? (e = (e, t) => Nl(e, r, i, `${t}`), t[6] = i, t[7] = r, t[8] = e) : e = t[8], c = s.map(e), t[2] = i, t[3] = r, t[4] = s, t[5] = c;
	} else c = t[5];
	let l;
	return t[9] === c ? l = t[10] : (l = /* @__PURE__ */ (0, H.jsx)(H.Fragment, { children: c }), t[9] = c, t[10] = l), l;
};
Pl.displayName = "GenerativeUIRender";
var Fl = (e) => {
	let t = N(4), { components: n, spec: r, Fallback: i } = e, a = B(Il), o = r ?? a;
	if (!o) return null;
	let s;
	return t[0] !== i || t[1] !== n || t[2] !== o ? (s = /* @__PURE__ */ (0, H.jsx)(Pl, {
		spec: o,
		components: n,
		Fallback: i
	}), t[0] = i, t[1] = n, t[2] = o, t[3] = s) : s = t[3], s;
};
Fl.displayName = "MessagePrimitive.GenerativeUI";
function Il(e) {
	let t = e.part;
	return t?.type === "generative-ui" ? t.spec : void 0;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/primitives/message/MessageParts.js
var Ll = (e) => {
	let t = -1;
	return {
		startGroup: (e) => {
			t === -1 && (t = e);
		},
		endGroup: (n, r) => {
			t !== -1 && (r.push({
				type: e,
				startIndex: t,
				endIndex: n
			}), t = -1);
		},
		finalize: (n, r) => {
			t !== -1 && r.push({
				type: e,
				startIndex: t,
				endIndex: n
			});
		}
	};
}, Rl = (e, t, n) => {
	let r = [];
	if (t) {
		let t = Ll("chainOfThoughtGroup");
		for (let n = 0; n < e.length; n++) {
			let i = e[n];
			i === "tool-call" || i === "reasoning" ? t.startGroup(n) : (t.endGroup(n - 1, r), r.push({
				type: "single",
				index: n
			}));
		}
		t.finalize(e.length - 1, r);
	} else {
		let t = Ll("toolGroup"), n = Ll("reasoningGroup");
		for (let i = 0; i < e.length; i++) {
			let a = e[i];
			a === "tool-call" ? (n.endGroup(i - 1, r), t.startGroup(i)) : a === "reasoning" ? (t.endGroup(i - 1, r), n.startGroup(i)) : (t.endGroup(i - 1, r), n.endGroup(i - 1, r), r.push({
				type: "single",
				index: i
			}));
		}
		t.finalize(e.length - 1, r), n.finalize(e.length - 1, r);
	}
	if (n) {
		let e = /* @__PURE__ */ new Set();
		for (let t of r) {
			if (t.type === "single") continue;
			let r = n[t.startIndex];
			r !== void 0 && !e.has(r) && (e.add(r), t.idKey = `id:${r}`);
		}
	}
	return r;
}, zl = (e) => {
	let t = N(10), n = B(Tr(cu)), r = B(Tr(uu)), i;
	bb0: {
		if (n.length === 0) {
			let e;
			t[0] === Symbol.for("react.memo_cache_sentinel") ? (e = [], t[0] = e) : e = t[0];
			let n;
			t[1] === r ? n = t[2] : (n = {
				ranges: e,
				partIds: r
			}, t[1] = r, t[2] = n), i = n;
			break bb0;
		}
		let a;
		t[3] !== n || t[4] !== r || t[5] !== e ? (a = Rl(n, e, r), t[3] = n, t[4] = r, t[5] = e, t[6] = a) : a = t[6];
		let o;
		t[7] !== r || t[8] !== a ? (o = {
			ranges: a,
			partIds: r
		}, t[7] = r, t[8] = a, t[9] = o) : o = t[9], i = o;
	}
	return i;
}, Bl = (e) => {
	let t = N(9), n, r;
	t[0] === e ? (n = t[1], r = t[2]) : ({Fallback: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r);
	let i;
	t[3] !== n || t[4] !== r.toolName ? (i = (e) => e.tools.toolUIs[r.toolName]?.[0]?.render ?? n, t[3] = n, t[4] = r.toolName, t[5] = i) : i = t[5];
	let a = B(i);
	if (!a) return null;
	let o;
	return t[6] !== a || t[7] !== r ? (o = /* @__PURE__ */ (0, H.jsx)(a, { ...r }), t[6] = a, t[7] = r, t[8] = o) : o = t[8], o;
}, Vl = (e, t, n) => e.renderers[t]?.[0] || (e.fallbacks[0] ?? n), Hl = (e) => {
	let t = N(9), n, r;
	t[0] === e ? (n = t[1], r = t[2]) : ({Fallback: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r);
	let i;
	t[3] !== n || t[4] !== r.name ? (i = (e) => Vl(e.dataRenderers, r.name, n), t[3] = n, t[4] = r.name, t[5] = i) : i = t[5];
	let a = B(i);
	if (!a) return null;
	let o;
	return t[6] !== a || t[7] !== r ? (o = /* @__PURE__ */ (0, H.jsx)(a, { ...r }), t[6] = a, t[7] = r, t[8] = o) : o = t[8], o;
}, Ul = {
	Text: () => null,
	Reasoning: () => null,
	Source: () => null,
	Image: () => null,
	File: () => null,
	Unstable_Audio: () => null,
	ToolGroup: ({ children: e }) => e,
	ReasoningGroup: ({ children: e }) => e
}, Wl = (e) => {
	let t = N(41), { components: n } = e, r;
	t[0] === n ? r = t[1] : (r = n === void 0 ? {} : n, t[0] = n, t[1] = r);
	let { Text: i, Reasoning: a, Image: o, Source: s, File: c, Unstable_Audio: l, tools: u, data: d, generativeUI: f } = r, p = i === void 0 ? Ul.Text : i, m = a === void 0 ? Ul.Reasoning : a, h = o === void 0 ? Ul.Image : o, g = s === void 0 ? Ul.Source : s, _ = c === void 0 ? Ul.File : c, v = l === void 0 ? Ul.Unstable_Audio : l, y;
	t[2] === u ? y = t[3] : (y = u === void 0 ? {} : u, t[2] = u, t[3] = y);
	let b = y, x = Kr(), S = B(du), C = S.type;
	if (C === "tool-call") {
		let e = x.part.addToolResult, n = x.part.resumeToolCall, r = x.part.respondToToolApproval;
		if ("Override" in b) {
			let i;
			return t[4] !== e || t[5] !== S || t[6] !== r || t[7] !== n || t[8] !== b.Override ? (i = /* @__PURE__ */ (0, H.jsx)(b.Override, {
				...S,
				addResult: e,
				resume: n,
				respondToApproval: r
			}), t[4] = e, t[5] = S, t[6] = r, t[7] = n, t[8] = b.Override, t[9] = i) : i = t[9], i;
		}
		let i = b.by_name?.[S.toolName] ?? b.Fallback, a;
		return t[10] !== i || t[11] !== e || t[12] !== S || t[13] !== r || t[14] !== n ? (a = /* @__PURE__ */ (0, H.jsx)(Bl, {
			...S,
			Fallback: i,
			addResult: e,
			resume: n,
			respondToApproval: r
		}), t[10] = i, t[11] = e, t[12] = S, t[13] = r, t[14] = n, t[15] = a) : a = t[15], a;
	}
	if (S.status?.type === "requires-action") throw Error("Encountered unexpected requires-action status");
	switch (C) {
		case "text": {
			let e;
			return t[16] !== p || t[17] !== S ? (e = /* @__PURE__ */ (0, H.jsx)(p, { ...S }), t[16] = p, t[17] = S, t[18] = e) : e = t[18], e;
		}
		case "reasoning": {
			let e;
			return t[19] !== m || t[20] !== S ? (e = /* @__PURE__ */ (0, H.jsx)(m, { ...S }), t[19] = m, t[20] = S, t[21] = e) : e = t[21], e;
		}
		case "source": {
			let e;
			return t[22] !== g || t[23] !== S ? (e = /* @__PURE__ */ (0, H.jsx)(g, { ...S }), t[22] = g, t[23] = S, t[24] = e) : e = t[24], e;
		}
		case "image": {
			let e;
			return t[25] !== h || t[26] !== S ? (e = /* @__PURE__ */ (0, H.jsx)(h, { ...S }), t[25] = h, t[26] = S, t[27] = e) : e = t[27], e;
		}
		case "file": {
			let e;
			return t[28] !== _ || t[29] !== S ? (e = /* @__PURE__ */ (0, H.jsx)(_, { ...S }), t[28] = _, t[29] = S, t[30] = e) : e = t[30], e;
		}
		case "audio": {
			let e;
			return t[31] !== v || t[32] !== S ? (e = /* @__PURE__ */ (0, H.jsx)(v, { ...S }), t[31] = v, t[32] = S, t[33] = e) : e = t[33], e;
		}
		case "data": {
			let e = d?.by_name?.[S.name] ?? d?.Fallback, n;
			return t[34] !== e || t[35] !== S ? (n = /* @__PURE__ */ (0, H.jsx)(Hl, {
				...S,
				Fallback: e
			}), t[34] = e, t[35] = S, t[36] = n) : n = t[36], n;
		}
		case "generative-ui": {
			if (!f?.components) return null;
			let e = S, n;
			return t[37] !== f.Fallback || t[38] !== f.components || t[39] !== e.spec ? (n = /* @__PURE__ */ (0, H.jsx)(Pl, {
				spec: e.spec,
				components: f.components,
				Fallback: f.Fallback
			}), t[37] = f.Fallback, t[38] = f.components, t[39] = e.spec, t[40] = n) : n = t[40], n;
		}
		default: return console.warn(`Unknown message part type: ${C}`), null;
	}
}, Gl = ut((e) => {
	let t = N(5), { index: n, components: r } = e, i;
	t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(Wl, { components: r }), t[0] = r, t[1] = i);
	let a;
	return t[2] !== n || t[3] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(Ms, {
		index: n,
		children: i
	}), t[2] = n, t[3] = i, t[4] = a) : a = t[4], a;
}, (e, t) => e.index === t.index && e.components?.Text === t.components?.Text && e.components?.Reasoning === t.components?.Reasoning && e.components?.Source === t.components?.Source && e.components?.Image === t.components?.Image && e.components?.File === t.components?.File && e.components?.Unstable_Audio === t.components?.Unstable_Audio && e.components?.tools === t.components?.tools && e.components?.data === t.components?.data && e.components?.generativeUI === t.components?.generativeUI && e.components?.ToolGroup === t.components?.ToolGroup && e.components?.ReasoningGroup === t.components?.ReasoningGroup);
Gl.displayName = "MessagePrimitive.PartByIndex";
var Kl = (e) => {
	let t = N(6), { status: n, component: r } = e, i = n.type === "running", a;
	t[0] !== r || t[1] !== n ? (a = /* @__PURE__ */ (0, H.jsx)(r, {
		type: "text",
		text: "",
		status: n
	}), t[0] = r, t[1] = n, t[2] = a) : a = t[2];
	let o;
	return t[3] !== i || t[4] !== a ? (o = /* @__PURE__ */ (0, H.jsx)(Ps, {
		text: "",
		isRunning: i,
		children: a
	}), t[3] = i, t[4] = a, t[5] = o) : o = t[5], o;
}, ql = Object.freeze({ type: "complete" }), Jl = Object.freeze({ type: "running" }), Yl = ut((e) => {
	let t = N(6), { components: n } = e, r = B(fu);
	if (n?.Empty) {
		let e;
		return t[0] !== n.Empty || t[1] !== r ? (e = /* @__PURE__ */ (0, H.jsx)(n.Empty, { status: r }), t[0] = n.Empty, t[1] = r, t[2] = e) : e = t[2], e;
	}
	if (r.type !== "running") return null;
	let i = n?.Text ?? Ul.Text, a;
	return t[3] !== r || t[4] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(Kl, {
		status: r,
		component: i
	}), t[3] = r, t[4] = i, t[5] = a) : a = t[5], a;
}, (e, t) => e.components?.Empty === t.components?.Empty && e.components?.Text === t.components?.Text), Xl = ut((e) => {
	let t = N(4), { components: n, enabled: r } = e, i;
	if (t[0] === r ? i = t[1] : (i = (e) => {
		if (!r || e.message.parts.length === 0) return !1;
		let t = e.message.parts[e.message.parts.length - 1];
		return t?.type !== "text" && t?.type !== "reasoning";
	}, t[0] = r, t[1] = i), !B(i)) return null;
	let a;
	return t[2] === n ? a = t[3] : (a = /* @__PURE__ */ (0, H.jsx)(Yl, { components: n }), t[2] = n, t[3] = a), a;
}, (e, t) => e.enabled === t.enabled && e.components?.Empty === t.components?.Empty && e.components?.Text === t.components?.Text), Zl = ut((e) => {
	let t = N(4), { Quote: n } = e, r = B(kl);
	if (!r) return null;
	let i;
	return t[0] !== n || t[1] !== r.messageId || t[2] !== r.text ? (i = /* @__PURE__ */ (0, H.jsx)(n, {
		text: r.text,
		messageId: r.messageId
	}), t[0] = n, t[1] = r.messageId, t[2] = r.text, t[3] = i) : i = t[3], i;
});
function Ql(e, t) {
	return (e.toolUIs[t.toolName]?.[0]?.render ?? null) || (oc(t.mcp?.app?.resourceUri) && e.mcpApp ? e.mcpApp.render : null);
}
var $l = () => {
	let e = N(6), t = Kr(), n = B(pu), r = B(mu);
	if (!r || n.type !== "tool-call") return null;
	let i;
	return e[0] !== r || e[1] !== t.part.addToolResult || e[2] !== t.part.respondToToolApproval || e[3] !== t.part.resumeToolCall || e[4] !== n ? (i = /* @__PURE__ */ (0, H.jsx)(r, {
		...n,
		addResult: t.part.addToolResult,
		resume: t.part.resumeToolCall,
		respondToApproval: t.part.respondToToolApproval
	}), e[0] = r, e[1] = t.part.addToolResult, e[2] = t.part.respondToToolApproval, e[3] = t.part.resumeToolCall, e[4] = n, e[5] = i) : i = e[5], i;
}, eu = () => {
	let e = N(3), t = B(hu), n = B(gu);
	if (!n || t.type !== "data") return null;
	let r = t, i;
	return e[0] !== n || e[1] !== r ? (i = /* @__PURE__ */ (0, H.jsx)(n, { ...r }), e[0] = n, e[1] = r, e[2] = i) : i = e[2], i;
}, tu = () => {
	let e = N(2), t = B(_u);
	if (t === "tool-call") {
		let t;
		return e[0] === Symbol.for("react.memo_cache_sentinel") ? (t = /* @__PURE__ */ (0, H.jsx)($l, {}), e[0] = t) : t = e[0], t;
	}
	if (t === "data") {
		let t;
		return e[1] === Symbol.for("react.memo_cache_sentinel") ? (t = /* @__PURE__ */ (0, H.jsx)(eu, {}), e[1] = t) : t = e[1], t;
	}
	return null;
}, nu = Object.freeze({
	type: "text",
	text: "",
	status: Jl
}), ru = ({ children: e }) => {
	let t = Kr(), n = B((e) => e.dataRenderers);
	return /* @__PURE__ */ (0, H.jsx)(Oa, {
		getItemState: (e) => e.part.getState(),
		children: (r) => e({ get part() {
			let e = r();
			if (e.type === "tool-call") {
				let n = Ql(t.tools.getState(), e) !== null, r = t.part;
				return {
					...e,
					toolUI: n ? /* @__PURE__ */ (0, H.jsx)($l, {}) : null,
					addResult: r.addToolResult,
					resume: r.resumeToolCall,
					respondToApproval: r.respondToToolApproval
				};
			}
			if (e.type === "data") {
				let t = Vl(n, e.name, void 0) !== void 0;
				return {
					...e,
					dataRendererUI: t ? /* @__PURE__ */ (0, H.jsx)(eu, {}) : null
				};
			}
			return e;
		} })
	});
}, iu = (e) => {
	let t = N(5), { index: n, children: r } = e, i;
	t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(ru, { children: r }), t[0] = r, t[1] = i);
	let a;
	return t[2] !== n || t[3] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(Ms, {
		index: n,
		children: i
	}), t[2] = n, t[3] = i, t[4] = a) : a = t[4], a;
}, au = (e) => {
	let t = N(9), { children: n } = e, r = B(vu), i = B(yu), a = r === 0 && i;
	if (r === 0) {
		if (!a) return null;
		let e;
		t[0] === n ? e = t[1] : (e = n({ part: nu }), t[0] = n, t[1] = e);
		let r;
		return t[2] === e ? r = t[3] : (r = /* @__PURE__ */ (0, H.jsx)(Ps, {
			text: "",
			isRunning: !0,
			children: e
		}), t[2] = e, t[3] = r), r;
	}
	let o;
	if (t[4] !== n || t[5] !== r) {
		let e;
		t[7] === n ? e = t[8] : (e = (e, t) => /* @__PURE__ */ (0, H.jsx)(iu, {
			index: t,
			children: (e) => n(e) ?? /* @__PURE__ */ (0, H.jsx)(tu, {})
		}, t), t[7] = n, t[8] = e), o = /* @__PURE__ */ (0, H.jsx)(H.Fragment, { children: Array.from({ length: r }, e) }), t[4] = n, t[5] = r, t[6] = o;
	} else o = t[6];
	return o;
}, W = (e) => {
	let t = N(5), { components: n, unstable_showEmptyOnNonTextEnd: r, children: i } = e, a = r === void 0 || r;
	if (i) {
		let e;
		return t[0] === i ? e = t[1] : (e = /* @__PURE__ */ (0, H.jsx)(au, { children: i }), t[0] = i, t[1] = e), e;
	}
	let o;
	return t[2] !== n || t[3] !== a ? (o = /* @__PURE__ */ (0, H.jsx)(ou, {
		components: n,
		unstable_showEmptyOnNonTextEnd: a
	}), t[2] = n, t[3] = a, t[4] = o) : o = t[4], o;
};
W.displayName = "MessagePrimitive.Parts";
var ou = (e) => {
	let t = N(15), { components: n, unstable_showEmptyOnNonTextEnd: r } = e, i = B(bu), { ranges: a, partIds: o } = zl(!!n?.ChainOfThought), s;
	bb0: {
		if (i === 0) {
			let e;
			t[0] === n ? e = t[1] : (e = /* @__PURE__ */ (0, H.jsx)(Yl, { components: n }), t[0] = n, t[1] = e), s = e;
			break bb0;
		}
		let e;
		if (t[2] !== n || t[3] !== a || t[4] !== o) {
			let r = /* @__PURE__ */ new Set(), i = (e) => {
				let t = o[e];
				return t !== void 0 && !r.has(t) ? (r.add(t), `part-id:${t}`) : `part-${e}`;
			};
			e = a.map((e) => {
				if (e.type === "single") return /* @__PURE__ */ (0, H.jsx)(Gl, {
					index: e.index,
					components: n
				}, e.index);
				if (e.type === "chainOfThoughtGroup") {
					let t = n?.ChainOfThought;
					return t ? /* @__PURE__ */ (0, H.jsx)(Vs, {
						startIndex: e.startIndex,
						endIndex: e.endIndex,
						children: /* @__PURE__ */ (0, H.jsx)(t, {})
					}, `chainOfThought-${e.idKey ?? e.startIndex}`) : null;
				}
				if (e.type === "toolGroup") {
					let t = n?.ToolGroup ?? Ul.ToolGroup;
					return /* @__PURE__ */ (0, H.jsx)(t, {
						startIndex: e.startIndex,
						endIndex: e.endIndex,
						children: Array.from({ length: e.endIndex - e.startIndex + 1 }, (t, r) => {
							let a = e.startIndex + r;
							return /* @__PURE__ */ (0, H.jsx)(Gl, {
								index: a,
								components: n
							}, i(a));
						})
					}, `tool-${e.idKey ?? e.startIndex}`);
				}
				{
					let t = n?.ReasoningGroup ?? Ul.ReasoningGroup;
					return /* @__PURE__ */ (0, H.jsx)(t, {
						startIndex: e.startIndex,
						endIndex: e.endIndex,
						children: Array.from({ length: e.endIndex - e.startIndex + 1 }, (t, r) => {
							let i = e.startIndex + r;
							return /* @__PURE__ */ (0, H.jsx)(Gl, {
								index: i,
								components: n
							}, `part-${i}`);
						})
					}, `reasoning-${e.startIndex}`);
				}
			}), t[2] = n, t[3] = a, t[4] = o, t[5] = e;
		} else e = t[5];
		s = e;
	}
	let c = s, l;
	t[6] === n ? l = t[7] : (l = n?.Quote && /* @__PURE__ */ (0, H.jsx)(Zl, { Quote: n.Quote }), t[6] = n, t[7] = l);
	let u;
	t[8] !== n || t[9] !== r ? (u = /* @__PURE__ */ (0, H.jsx)(Xl, {
		components: n,
		enabled: r
	}), t[8] = n, t[9] = r, t[10] = u) : u = t[10];
	let d;
	return t[11] !== c || t[12] !== l || t[13] !== u ? (d = /* @__PURE__ */ (0, H.jsxs)(H.Fragment, { children: [
		l,
		c,
		u
	] }), t[11] = c, t[12] = l, t[13] = u, t[14] = d) : d = t[14], d;
};
function su(e) {
	return e.type;
}
function cu(e) {
	return e.message.parts.map(su);
}
function lu(e) {
	return e.type === "tool-call" ? e.toolCallId : void 0;
}
function uu(e) {
	return e.message.parts.map(lu);
}
function du(e) {
	return e.part;
}
function fu(e) {
	return e.message.status ?? ql;
}
function pu(e) {
	return e.part;
}
function mu(e) {
	return e.part.type === "tool-call" ? Ql(e.tools, e.part) : null;
}
function hu(e) {
	return e.part;
}
function gu(e) {
	return e.part.type === "data" ? Vl(e.dataRenderers, e.part.name, void 0) ?? null : null;
}
function _u(e) {
	return e.part.type;
}
function vu(e) {
	return e.message.parts.length;
}
function yu(e) {
	return (e.message.status?.type ?? "complete") === "running";
}
function bu(e) {
	return e.message.parts.length;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/utils/groupParts.js
var xu = Symbol.for("@assistant-ui/groupBy.memoKey"), Su = (e) => {
	let t = e.nextChildIdx++;
	return e.nodeKey === "" ? String(t) : `${e.nodeKey}.${t}`;
}, Cu = (e, t) => {
	if (!(t === void 0 || e.claimed.has(t))) return e.claimed.add(t), `id:${t}`;
}, wu = (e, t) => {
	let n = {
		key: "",
		nodeKey: "",
		indices: [],
		children: [],
		nextChildIdx: 0,
		claimed: /* @__PURE__ */ new Set()
	}, r = [n], i = () => {
		let e = r.pop(), n = r[r.length - 1];
		n.children.push({
			type: "group",
			key: e.key,
			nodeKey: e.nodeKey,
			idKey: Cu(n, t?.[e.indices[0]]),
			indices: e.indices,
			children: e.children
		});
	};
	for (let n = 0; n < e.length; n++) {
		let a = e[n], o = 0;
		for (; o < r.length - 1 && o < a.length && r[o + 1].key === a[o];) o++;
		for (; r.length - 1 > o;) i();
		for (; r.length - 1 < a.length;) {
			let e = r[r.length - 1];
			r.push({
				key: a[r.length - 1],
				nodeKey: Su(e),
				indices: [],
				children: [],
				nextChildIdx: 0,
				claimed: /* @__PURE__ */ new Set()
			});
		}
		let s = r[r.length - 1];
		s.children.push({
			type: "part",
			index: n,
			nodeKey: Su(s),
			idKey: Cu(s, t?.[n])
		});
		for (let e = 1; e < r.length; e++) r[e].indices.push(n);
	}
	for (; r.length > 1;) i();
	return n.children;
}, Tu = (e, t, n) => {
	if (!n) return !1;
	switch (e) {
		case "never": return !1;
		case "always": return !0;
		case "empty": return t.length === 0;
		case "no-text": {
			let e = t[t.length - 1];
			return e === void 0 || e.type !== "text" && e.type !== "reasoning";
		}
	}
}, Eu = () => {
	throw Error("MessagePrimitive.GroupedParts: rendered `children` under a leaf part. `children` is only meaningful for `group-…` cases — add a matching case for the part type or return `null` to skip it.");
}, Du = (e, t, n) => {
	if (e.type === "part") return /* @__PURE__ */ (0, H.jsx)(iu, {
		index: e.index,
		children: ({ part: e }) => n({
			part: e,
			children: /* @__PURE__ */ (0, H.jsx)(Eu, {})
		})
	}, e.idKey ? `part-${e.idKey}` : `part-${e.index}`);
	let { status: r, counts: i } = zs(t, e.indices), a = {
		type: e.key,
		status: r,
		counts: i,
		indices: e.indices
	};
	return /* @__PURE__ */ (0, H.jsx)(dt, { children: n({
		part: a,
		children: /* @__PURE__ */ (0, H.jsx)(H.Fragment, { children: e.children.map((e) => Du(e, t, n)) })
	}) }, e.idKey ?? e.nodeKey);
}, Ou = ({ groupBy: e, indicator: t = "no-text", children: n }) => {
	let r = B(Tr((e) => e.message.parts)), i = B((e) => e.tools.toolUIs), a = B((e) => t !== "never" && e.message.status?.type === "running"), o = tt(() => {
		let t = { toolUIs: i };
		return wu(r.map((n) => e(n, t) ?? []), r.map((e) => e.type === "tool-call" ? e.toolCallId : void 0));
	}, [
		r,
		e[xu] ?? e,
		i
	]);
	return /* @__PURE__ */ (0, H.jsxs)(H.Fragment, { children: [o.map((e) => Du(e, r, n)), Tu(t, r, a) && n({
		part: { type: "indicator" },
		children: /* @__PURE__ */ (0, H.jsx)(Eu, {})
	})] });
};
Ou.displayName = "MessagePrimitive.GroupedParts";
var ku = ut((e) => {
	let t = N(5), { children: n } = e, r = B(kl);
	if (!r) return null;
	let i;
	t[0] !== n || t[1] !== r ? (i = n(r), t[0] = n, t[1] = r, t[2] = i) : i = t[2];
	let a;
	return t[3] === i ? a = t[4] : (a = /* @__PURE__ */ (0, H.jsx)(H.Fragment, { children: i }), t[3] = i, t[4] = a), a;
});
ku.displayName = "MessagePrimitive.Quote";
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/primitives/message/MessageAttachments.js
var Au = (e, t) => {
	switch (t.type) {
		case "image": return e?.Image ?? e?.Attachment;
		case "document": return e?.Document ?? e?.Attachment;
		case "file": return e?.File ?? e?.Attachment;
		default: return e?.Attachment;
	}
}, ju = (e) => {
	let t = N(5), { components: n } = e, r = B(Fu);
	if (!r) return null;
	let i = r, a;
	t[0] !== n || t[1] !== i ? (a = Au(n, i), t[0] = n, t[1] = i, t[2] = a) : a = t[2];
	let o = a;
	if (!o) return null;
	let s;
	return t[3] === o ? s = t[4] : (s = /* @__PURE__ */ (0, H.jsx)(o, {}), t[3] = o, t[4] = s), s;
}, Mu = ut((e) => {
	let t = N(5), { index: n, components: r } = e, i;
	t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(ju, { components: r }), t[0] = r, t[1] = i);
	let a;
	return t[2] !== n || t[3] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(As, {
		index: n,
		children: i
	}), t[2] = n, t[3] = i, t[4] = a) : a = t[4], a;
}, (e, t) => e.index === t.index && e.components?.Image === t.components?.Image && e.components?.Document === t.components?.Document && e.components?.File === t.components?.File && e.components?.Attachment === t.components?.Attachment);
Mu.displayName = "MessagePrimitive.AttachmentByIndex";
var Nu = ({ children: e }) => {
	let t = B(Tr((e) => e.message.role === "user" ? (e.message.attachments ?? []).map((e) => e.id) : []));
	return tt(() => t.map((t, n) => /* @__PURE__ */ (0, H.jsx)(As, {
		index: n,
		children: /* @__PURE__ */ (0, H.jsx)(Oa, {
			getItemState: (e) => e.message.attachment({ index: n }).getState(),
			children: (t) => e({ get attachment() {
				return t();
			} })
		})
	}, t)), [t, e]);
}, Pu = (e) => {
	let t = N(4), { components: n, children: r } = e;
	if (n) {
		let e;
		return t[0] === n ? e = t[1] : (e = /* @__PURE__ */ (0, H.jsx)(Nu, { children: (e) => {
			let { attachment: t } = e, r = Au(n, t);
			return r ? /* @__PURE__ */ (0, H.jsx)(r, {}) : null;
		} }), t[0] = n, t[1] = e), e;
	}
	let i;
	return t[2] === r ? i = t[3] : (i = /* @__PURE__ */ (0, H.jsx)(Nu, { children: r }), t[2] = r, t[3] = i), i;
};
Pu.displayName = "MessagePrimitive.Attachments";
function Fu(e) {
	return e.attachment;
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/primitives/messagePart/MessagePartInProgress.js
var Iu = (e) => {
	let { children: t } = e;
	return B(Lu) ? t : null;
};
Iu.displayName = "MessagePartPrimitive.InProgress";
function Lu(e) {
	return e.part.status.type === "running";
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/primitives/thread/ThreadSuggestions.js
var Ru = (e) => {
	let t = N(2), { components: n } = e, r = n.Suggestion, i;
	return t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(r, {}), t[0] = r, t[1] = i), i;
}, zu = ut((e) => {
	let t = N(5), { index: n, components: r } = e, i;
	t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(Ru, { components: r }), t[0] = r, t[1] = i);
	let a;
	return t[2] !== n || t[3] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(Us, {
		index: n,
		children: i
	}), t[2] = n, t[3] = i, t[4] = a) : a = t[4], a;
}, (e, t) => e.index === t.index && e.components.Suggestion === t.components.Suggestion);
zu.displayName = "ThreadPrimitive.SuggestionByIndex";
var Bu = ({ children: e }) => {
	let t = B((e) => e.suggestions.suggestions.length);
	return tt(() => t === 0 ? null : Array.from({ length: t }, (t, n) => /* @__PURE__ */ (0, H.jsx)(Us, {
		index: n,
		children: /* @__PURE__ */ (0, H.jsx)(Oa, {
			getItemState: (e) => e.suggestions.suggestion({ index: n }).getState(),
			children: (t) => e({ get suggestion() {
				return t();
			} })
		})
	}, n)), [t, e]);
}, Vu = (e) => {
	let t = N(4), { components: n, children: r } = e;
	if (n) {
		let e;
		return t[0] === n ? e = t[1] : (e = /* @__PURE__ */ (0, H.jsx)(Bu, { children: () => /* @__PURE__ */ (0, H.jsx)(Ru, { components: n }) }), t[0] = n, t[1] = e), e;
	}
	let i;
	return t[2] === r ? i = t[3] : (i = /* @__PURE__ */ (0, H.jsx)(Bu, { children: r }), t[2] = r, t[3] = i), i;
};
Vu.displayName = "ThreadPrimitive.Suggestions";
var Hu = ut(Vu, (e, t) => e.children || t.children ? e.children === t.children : e.components.Suggestion === t.components.Suggestion), Uu = (e, t) => e.thread.isDisabled || t && e.thread.isRunning && !e.thread.capabilities.queue, Wu = (e) => {
	if (e.message.status?.type !== "incomplete" || e.message.status.reason !== "error") return;
	let t = e.message.status.error;
	return typeof t == "string" ? t : typeof t == "object" && t && "message" in t && typeof t.message == "string" ? t.message : t ?? "An error occurred";
}, Gu = (e) => {
	let t = N(10), { prompt: n, send: r, clearComposer: i } = e, a = i === void 0 || i, o = Kr(), s = r ?? !1, c;
	t[0] === s ? c = t[1] : (c = (e) => Uu(e, s), t[0] = s, t[1] = c);
	let l = B(c), u;
	t[2] !== o || t[3] !== a || t[4] !== n || t[5] !== s ? (u = () => {
		if (s) {
			let { isRunning: e, capabilities: t } = o.thread.getState();
			if (e && !t.queue) return;
			o.thread.append({
				content: [{
					type: "text",
					text: n
				}],
				runConfig: o.composer.getState().runConfig
			}), a && !e && o.composer.setText("");
		} else if (a) o.composer.setText(n);
		else {
			let e = o.composer.getState().text;
			o.composer.setText([e, n].filter(Ku).join(" "));
		}
	}, t[2] = o, t[3] = a, t[4] = n, t[5] = s, t[6] = u) : u = t[6];
	let d = u, f;
	return t[7] !== l || t[8] !== d ? (f = {
		trigger: d,
		disabled: l
	}, t[7] = l, t[8] = d, t[9] = f) : f = t[9], f;
};
function Ku(e) {
	return e.trim();
}
//#endregion
//#region node_modules/@assistant-ui/core/dist/react/primitive-hooks/useMessageError.js
var qu = () => B(Wu), Ju = (e) => {
	let { cloud: t, initialMessages: n, maxSteps: r, adapters: i, unstable_humanToolNames: a, unstable_enableMessageQueue: o, unstable_queueClearOnRewind: s, unstable_queueClearOnCancel: c, ...l } = e;
	return {
		localRuntimeOptions: {
			cloud: t,
			initialMessages: n,
			maxSteps: r,
			adapters: i,
			unstable_humanToolNames: a,
			unstable_enableMessageQueue: o,
			unstable_queueClearOnRewind: s,
			unstable_queueClearOnCancel: c
		},
		otherOptions: l
	};
};
//#endregion
//#region node_modules/@assistant-ui/react/dist/context/react/utils/createContextHook.js
function Yu(e, t) {
	function n(n) {
		let r = _t(e);
		if (!n?.optional && !r) throw Error(`This component must be used within ${t}.`);
		return r;
	}
	return n;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/context/react/utils/createContextStoreHook.js
function Xu(e, t) {
	function n(n) {
		let r = e(n);
		return r ? r[t] : null;
	}
	function r(e) {
		let t = !1, r;
		typeof e == "function" ? r = e : e && typeof e == "object" && (t = !!e.optional, r = e.selector);
		let i = n({ optional: t });
		return i ? r ? i(r) : i() : null;
	}
	return {
		[t]: r,
		[`${t}Store`]: n
	};
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/context/react/ThreadViewportContext.js
var Zu = ht(null), { useThreadViewport: Qu, useThreadViewportStore: $u } = Xu(Yu(Zu, "ThreadPrimitive.Viewport"), "useThreadViewport"), ed = (e) => {
	let t, n = /* @__PURE__ */ new Set(), r = (e, r) => {
		let i = typeof e == "function" ? e(t) : e;
		if (!Object.is(i, t)) {
			let e = t;
			t = r ?? (typeof i != "object" || !i) ? i : Object.assign({}, t, i), n.forEach((n) => n(t, e));
		}
	}, i = () => t, a = {
		setState: r,
		getState: i,
		getInitialState: () => o,
		subscribe: (e) => (n.add(e), () => n.delete(e))
	}, o = t = e(r, i, a);
	return a;
}, G = ((e) => e ? ed(e) : ed), td = (e) => e;
function K(e, t = td) {
	let n = j.useSyncExternalStore(e.subscribe, j.useCallback(() => t(e.getState()), [e, t]), j.useCallback(() => t(e.getInitialState()), [e, t]));
	return j.useDebugValue(n), n;
}
var q = (e) => {
	let t = G(e), n = (e) => K(t, e);
	return Object.assign(n, t), n;
}, nd = ((e) => e ? q(e) : q), rd = (e) => {
	let t = /* @__PURE__ */ new Map(), n = () => {
		let n = 0;
		for (let e of t.values()) n += e;
		e(n);
	};
	return { register: () => {
		let e = Symbol();
		return t.set(e, 0), {
			setHeight: (r) => {
				t.get(e) !== r && (t.set(e, r), n());
			},
			unregister: () => {
				t.delete(e), n();
			}
		};
	} };
}, id = (e = {}) => {
	let t = /* @__PURE__ */ new Set(), n = rd((e) => {
		a.setState({ height: {
			...a.getState().height,
			viewport: e
		} });
	}), r = rd((e) => {
		a.setState({ height: {
			...a.getState().height,
			inset: e
		} });
	}), i = (e, t) => (a.setState({ element: {
		...a.getState().element,
		[e]: t
	} }), () => {
		a.getState().element[e] === t && a.setState({ element: {
			...a.getState().element,
			[e]: null
		} });
	}), a = nd(() => ({
		isAtBottom: !0,
		scrollToBottom: ({ behavior: e = "auto" } = {}) => {
			_n(t, () => ({ behavior: e }), "Thread viewport");
		},
		onScrollToBottom: (e) => (t.add(e), () => {
			t.delete(e);
		}),
		turnAnchor: e.turnAnchor ?? "bottom",
		topAnchorMessageClamp: {
			tallerThan: e.topAnchorMessageClamp?.tallerThan ?? "10em",
			visibleHeight: e.topAnchorMessageClamp?.visibleHeight ?? "6em"
		},
		height: {
			viewport: 0,
			inset: 0
		},
		element: {
			viewport: null,
			anchor: null,
			target: null
		},
		targetConfig: null,
		topAnchorTurn: null,
		registerViewport: n.register,
		registerContentInset: r.register,
		registerViewportElement: (e) => i("viewport", e),
		registerAnchorElement: (e) => i("anchor", e),
		registerAnchorTargetElement: (e, t) => (a.setState({
			element: {
				...a.getState().element,
				target: e
			},
			targetConfig: e && t ? t : null
		}), () => {
			a.getState().element.target === e && a.setState({
				element: {
					...a.getState().element,
					target: null
				},
				targetConfig: null
			});
		}),
		setTopAnchorTurn: (e) => {
			a.setState({ topAnchorTurn: e });
		}
	}));
	return a;
}, ad = (e) => e, od = (e) => {
	let t = N(11), n;
	t[0] === Symbol.for("react.memo_cache_sentinel") ? (n = { optional: !0 }, t[0] = n) : n = t[0];
	let r = $u(n), i;
	t[1] === e ? i = t[2] : (i = () => id(e), t[1] = e, t[2] = i);
	let [a] = Qe(i), o, s;
	t[3] !== r || t[4] !== a ? (o = () => r?.getState().onScrollToBottom((e) => {
		a.getState().scrollToBottom(e);
	}), s = [r, a], t[3] = r, t[4] = a, t[5] = o, t[6] = s) : (o = t[5], s = t[6]), R(o, s);
	let c, l;
	return t[7] !== r || t[8] !== a ? (c = () => {
		if (r) return a.subscribe((e) => {
			r.getState().isAtBottom !== e.isAtBottom && ad(r).setState({ isAtBottom: e.isAtBottom });
		});
	}, l = [a, r], t[7] = r, t[8] = a, t[9] = c, t[10] = l) : (c = t[9], l = t[10]), R(c, l), a;
}, sd = (e) => {
	let t = N(7), { children: n, options: r } = e, i;
	t[0] === r ? i = t[1] : (i = r === void 0 ? {} : r, t[0] = r, t[1] = i);
	let a = od(i), o;
	t[2] === a ? o = t[3] : (o = () => ({ useThreadViewport: a }), t[2] = a, t[3] = o);
	let [s] = Qe(o), c;
	return t[4] !== n || t[5] !== s ? (c = /* @__PURE__ */ (0, H.jsx)(Zu.Provider, {
		value: s,
		children: n
	}), t[4] = n, t[5] = s, t[6] = c) : c = t[6], c;
}, cd = () => {
	let e = N(3), t = Kr(), n, r;
	return e[0] === t ? (n = e[1], r = e[2]) : (n = () => {}, r = [t], e[0] = t, e[1] = n, e[2] = r), R(n, r), null;
}, ld = ut((e) => {
	let t = N(8), { children: n, aui: r, config: i, runtime: a } = e, o = r ?? null, s;
	t[0] === Symbol.for("react.memo_cache_sentinel") ? (s = /* @__PURE__ */ (0, H.jsx)(cd, {}), t[0] = s) : s = t[0];
	let c;
	t[1] === n ? c = t[2] : (c = /* @__PURE__ */ (0, H.jsx)(sd, { children: n }), t[1] = n, t[2] = c);
	let l;
	return t[3] !== i || t[4] !== a || t[5] !== o || t[6] !== c ? (l = /* @__PURE__ */ (0, H.jsxs)(Na, {
		runtime: a,
		aui: o,
		config: i,
		children: [s, c]
	}), t[3] = i, t[4] = a, t[5] = o, t[6] = c, t[7] = l) : l = t[7], l;
}), ud = Object.defineProperty, dd = (e, t) => ud(e, "name", {
	value: t,
	configurable: !0
});
function fd(e, t) {
	if (typeof e == "function") return e(t);
	e != null && (e.current = t);
}
dd(fd, "setRef");
function pd(...e) {
	return (t) => {
		let n = !1, r = e.map((e) => {
			let r = fd(e, t);
			return !n && typeof r == "function" && (n = !0), r;
		});
		if (n) return () => {
			for (let t = 0; t < r.length; t++) {
				let n = r[t];
				typeof n == "function" ? n() : fd(e[t], null);
			}
		};
	};
}
dd(pd, "composeRefs");
function md(...e) {
	return j.useCallback(pd(...e), e);
}
dd(md, "useComposedRefs");
//#endregion
//#region node_modules/@radix-ui/react-slot/dist/index.mjs
var hd = Object.defineProperty, gd = (e, t) => hd(e, "name", {
	value: t,
	configurable: !0
});
// @__NO_SIDE_EFFECTS__
function _d(e) {
	let t = j.forwardRef((t, n) => {
		let { children: r, ...i } = t, a = null, o = !1, s = [];
		Ed(r) && typeof Ad == "function" && (r = Ad(r._payload)), j.Children.forEach(r, (e) => {
			if (wd(e)) {
				o = !0;
				let t = e, n = "child" in t.props ? t.props.child : t.props.children;
				Ed(n) && typeof Ad == "function" && (n = Ad(n._payload)), a = xd(t, n), s.push(a?.props?.children);
			} else s.push(e);
		}), a ? a = j.cloneElement(a, void 0, s) : !o && j.Children.count(r) === 1 && j.isValidElement(r) && (a = r);
		let c = a ? Cd(a) : void 0, l = md(n, c);
		if (!a) {
			if (r || r === 0) throw Error(o ? kd(e) : Od(e));
			return r;
		}
		let u = Sd(i, a.props ?? {});
		return a.type !== j.Fragment && (u.ref = n ? l : c), j.cloneElement(a, u);
	});
	return t.displayName = `${e}.Slot`, t;
}
gd(_d, "createSlot");
var vd = /* @__PURE__ */ _d("Slot"), yd = Symbol.for("radix.slottable");
// @__NO_SIDE_EFFECTS__
function bd(e) {
	let t = /* @__PURE__ */ gd((e) => "child" in e ? e.children(e.child) : e.children, "Slottable");
	return t.displayName = `${e}.Slottable`, t.__radixId = yd, t;
}
gd(bd, "createSlottable");
var xd = /* @__PURE__ */ gd((e, t) => {
	if ("child" in e.props) {
		let t = e.props.child;
		return j.isValidElement(t) ? j.cloneElement(t, void 0, e.props.children(t.props.children)) : null;
	}
	return j.isValidElement(t) ? t : null;
}, "getSlottableElementFromSlottable");
function Sd(e, t) {
	let n = { ...t };
	for (let r in t) {
		let i = e[r], a = t[r];
		/^on[A-Z]/.test(r) ? i && a ? n[r] = (...e) => {
			let t = a(...e);
			return i(...e), t;
		} : i && (n[r] = i) : r === "style" ? n[r] = {
			...i,
			...a
		} : r === "className" && (n[r] = [i, a].filter(Boolean).join(" "));
	}
	return {
		...e,
		...n
	};
}
gd(Sd, "mergeProps");
function Cd(e) {
	let t = Object.getOwnPropertyDescriptor(e.props, "ref")?.get, n = t && "isReactWarning" in t && t.isReactWarning;
	return n ? e.ref : (t = Object.getOwnPropertyDescriptor(e, "ref")?.get, n = t && "isReactWarning" in t && t.isReactWarning, n ? e.props.ref : e.props.ref || e.ref);
}
gd(Cd, "getElementRef");
function wd(e) {
	return j.isValidElement(e) && typeof e.type == "function" && "__radixId" in e.type && e.type.__radixId === yd;
}
gd(wd, "isSlottable");
var Td = Symbol.for("react.lazy");
function Ed(e) {
	return typeof e == "object" && !!e && "$$typeof" in e && e.$$typeof === Td && "_payload" in e && Dd(e._payload);
}
gd(Ed, "isLazyComponent");
function Dd(e) {
	return typeof e == "object" && !!e && "then" in e;
}
gd(Dd, "isPromiseLike");
var Od = /* @__PURE__ */ gd((e) => `${e} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`, "createSlotError"), kd = /* @__PURE__ */ gd((e) => `${e} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`, "createSlottableError"), Ad = j.use, jd = /* @__PURE__ */ l(h(), 1), Md = Object.defineProperty, Nd = (e, t) => Md(e, "name", {
	value: t,
	configurable: !0
}), Pd = [
	"a",
	"button",
	"div",
	"form",
	"h2",
	"h3",
	"img",
	"input",
	"label",
	"li",
	"nav",
	"ol",
	"p",
	"select",
	"span",
	"svg",
	"ul"
].reduce((e, t) => {
	let n = /* @__PURE__ */ _d(`Primitive.${t}`), r = j.forwardRef((e, r) => {
		let { asChild: i, ...a } = e, o = i ? n : t;
		return typeof window < "u" && (window[Symbol.for("radix-ui")] = !0), /* @__PURE__ */ (0, H.jsx)(o, {
			...a,
			ref: r
		});
	});
	return r.displayName = `Primitive.${t}`, {
		...e,
		[t]: r
	};
}, {});
function Fd(e, t) {
	e && jd.flushSync(() => e.dispatchEvent(t));
}
Nd(Fd, "dispatchDiscreteCustomEvent");
//#endregion
//#region node_modules/@radix-ui/primitive/dist/index.mjs
var Id = Object.defineProperty, Ld = (e, t) => Id(e, "name", {
	value: t,
	configurable: !0
}), Rd = !!(typeof window < "u" && window.document && window.document.createElement);
function zd(e, t, { checkForDefaultPrevented: n = !0 } = {}) {
	return /* @__PURE__ */ Ld(function(r) {
		if (e?.(r), n === !1 || !r || !r.defaultPrevented) return t?.(r);
	}, "handleEvent");
}
Ld(zd, "composeEventHandlers");
function Bd(e) {
	if (!Rd) throw Error("Cannot access window outside of the DOM");
	return e?.ownerDocument?.defaultView ?? window;
}
Ld(Bd, "getOwnerWindow");
function Vd(e) {
	if (!Rd) throw Error("Cannot access document outside of the DOM");
	return e?.ownerDocument ?? document;
}
Ld(Vd, "getOwnerDocument");
function Hd(e, t = !1) {
	let { activeElement: n } = Vd(e);
	if (!n?.nodeName) return null;
	if (Ud(n) && n.contentDocument) return Hd(n.contentDocument.body, t);
	if (t) {
		let e = n.getAttribute("aria-activedescendant");
		if (e) {
			let t = Vd(n).getElementById(e);
			if (t) return t;
		}
	}
	return n;
}
Ld(Hd, "getActiveElement");
function Ud(e) {
	return e.tagName === "IFRAME";
}
Ld(Ud, "isFrame");
//#endregion
//#region node_modules/@radix-ui/react-use-callback-ref/dist/index.mjs
var Wd = Object.defineProperty, Gd = (e, t) => Wd(e, "name", {
	value: t,
	configurable: !0
});
function Kd(e) {
	let t = j.useRef(e);
	return j.useEffect(() => {
		t.current = e;
	}), j.useMemo(() => ((...e) => t.current?.(...e)), []);
}
Gd(Kd, "useCallbackRef");
//#endregion
//#region node_modules/radix-ui/dist/internal.mjs
var qd = Pd;
qd.dispatchDiscreteCustomEvent = Fd, qd.Root = Pd;
//#endregion
//#region node_modules/@assistant-ui/react/dist/_virtual/_rolldown/runtime.js
var Jd = Object.defineProperty, Yd = (e, t) => {
	let n = {};
	for (var r in e) Jd(n, r, {
		get: e[r],
		enumerable: !0
	});
	return t || Jd(n, Symbol.toStringTag, { value: "Module" }), n;
}, Xd = [
	"a",
	"button",
	"div",
	"form",
	"h2",
	"h3",
	"img",
	"input",
	"label",
	"li",
	"nav",
	"ol",
	"p",
	"select",
	"span",
	"svg",
	"ul"
];
function Zd(e, t) {
	return pt(e, void 0, t === void 0 ? e.props.children : t);
}
function Qd(e, t, n) {
	return /* @__PURE__ */ (0, H.jsx)(vd, {
		...n,
		children: Zd(e, t)
	});
}
function $d(e) {
	let t = lt((t, n) => {
		let r = N(17), i, a, o, s;
		r[0] === t ? (i = r[1], a = r[2], o = r[3], s = r[4]) : ({render: o, asChild: i, children: a, ...s} = t, r[0] = t, r[1] = i, r[2] = a, r[3] = o, r[4] = s);
		let c = e;
		if (o && mt(o)) {
			let e = s, t;
			r[5] !== a || r[6] !== o ? (t = Zd(o, a), r[5] = a, r[6] = o, r[7] = t) : t = r[7];
			let i;
			return r[8] !== n || r[9] !== e || r[10] !== t ? (i = /* @__PURE__ */ (0, H.jsx)(c, {
				...e,
				asChild: !0,
				ref: n,
				children: t
			}), r[8] = n, r[9] = e, r[10] = t, r[11] = i) : i = r[11], i;
		}
		let l = s, u;
		return r[12] !== i || r[13] !== a || r[14] !== n || r[15] !== l ? (u = /* @__PURE__ */ (0, H.jsx)(c, {
			...l,
			asChild: i,
			ref: n,
			children: a
		}), r[12] = i, r[13] = a, r[14] = n, r[15] = l, r[16] = u) : u = r[16], u;
	});
	return t.displayName = typeof e == "string" ? e : e.displayName ?? e.name ?? "Component", t;
}
function ef(e) {
	let t = qd[e], n = $d(t);
	return n.displayName = `Primitive.${e}`, n;
}
var tf = Xd.reduce((e, t) => (e[t] = ef(t), e), {}), nf = (e, t, n = []) => {
	let r = lt((e, r) => {
		let i = N(6), a = {}, o = {};
		Object.keys(e).forEach((t) => {
			n.includes(t) ? a[t] = e[t] : o[t] = e[t];
		});
		let s = t(a) ?? void 0, c = tf, l = o.disabled || !s, u = zd(o.onClick, s), d;
		return i[0] !== r || i[1] !== o || i[2] !== c.button || i[3] !== l || i[4] !== u ? (d = /* @__PURE__ */ (0, H.jsx)(c.button, {
			type: "button",
			...o,
			ref: r,
			disabled: l,
			onClick: u
		}), i[0] = r, i[1] = o, i[2] = c.button, i[3] = l, i[4] = u, i[5] = d) : d = i[5], d;
	});
	return r.displayName = e, r;
}, rf = ht(null), af = () => _t(rf), of = (e) => {
	let t = N(4), n = Kd(e), r = Qu(sf), i, a;
	t[0] !== n || t[1] !== r ? (i = () => r(n), a = [r, n], t[0] = n, t[1] = r, t[2] = i, t[3] = a) : (i = t[2], a = t[3]), R(i, a);
};
function sf(e) {
	return e.onScrollToBottom;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/utils/hooks/useMediaQuery.js
var cf = () => !1, lf = () => {}, uf = (e) => {
	let t = N(4), n;
	t[0] === e ? n = t[1] : (n = (t) => {
		if (typeof window > "u" || e === null || !window.matchMedia) return lf;
		let n = window.matchMedia(e);
		return n.addEventListener("change", t), () => n.removeEventListener("change", t);
	}, t[0] = e, t[1] = n);
	let r = n, i;
	return t[2] === e ? i = t[3] : (i = () => typeof window > "u" || e === null || !window.matchMedia ? !1 : window.matchMedia(e).matches, t[2] = e, t[3] = i), at(r, i, cf);
}, df = Object.freeze({ type: "complete" }), ff = Object.freeze({
	type: "text",
	text: "",
	status: df
}), pf = () => B(mf);
function mf(e) {
	return e.part.type !== "text" && e.part.type !== "reasoning" ? ff : e.part;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/utils/smooth/SmoothContext.js
var hf = ht(null), gf = (e) => ({ useSmoothStatus: nd(() => e) }), _f = (e) => {
	let t = N(6), { children: n } = e, r;
	t[0] === Symbol.for("react.memo_cache_sentinel") ? (r = { optional: !0 }, t[0] = r) : r = t[0];
	let i = yf(r), a = Kr(), o;
	t[1] === a.part ? o = t[2] : (o = () => gf(a.part.getState().status), t[1] = a.part, t[2] = o);
	let [s] = Qe(o);
	if (i) return n;
	let c;
	return t[3] !== n || t[4] !== s ? (c = /* @__PURE__ */ (0, H.jsx)(hf.Provider, {
		value: s,
		children: n
	}), t[3] = n, t[4] = s, t[5] = c) : c = t[5], c;
}, vf = (e) => {
	let t = lt((t, n) => {
		let r = N(3), i = t, a;
		return r[0] !== n || r[1] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(_f, { children: /* @__PURE__ */ (0, H.jsx)(e, {
			...i,
			ref: n
		}) }), r[0] = n, r[1] = i, r[2] = a) : a = r[2], a;
	});
	return t.displayName = e.displayName, t;
};
function yf(e) {
	let t = _t(hf);
	if (!e?.optional && !t) throw Error("This component must be used within a SmoothContextProvider.");
	return t;
}
var { useSmoothStatus: bf, useSmoothStatusStore: xf } = Xu(yf, "useSmoothStatus"), Sf = 250, Cf = 5, wf = class {
	animationFrameId = null;
	lastUpdateTime = Date.now();
	lastCommitTime = 0;
	targetText = "";
	drainMs = Sf;
	maxCharIntervalMs = Cf;
	maxCharsPerFrame = Infinity;
	minCommitMs = 0;
	currentText;
	setText;
	constructor(e, t) {
		this.currentText = e, this.setText = t;
	}
	start() {
		this.animationFrameId === null && (this.lastUpdateTime = Date.now(), this.animate());
	}
	stop() {
		this.animationFrameId !== null && (cancelAnimationFrame(this.animationFrameId), this.animationFrameId = null);
	}
	animate = () => {
		let e = Date.now(), t = e - this.lastUpdateTime, n = this.targetText.length - this.currentText.length, r = Math.min(this.maxCharIntervalMs, this.drainMs / n), i = Math.min(n, this.maxCharsPerFrame), a = 0;
		for (; t >= r && a < i;) a++, t -= r;
		a === i && i === this.maxCharsPerFrame && (t = 0), this.animationFrameId = a === n ? null : requestAnimationFrame(this.animate), a !== 0 && (this.currentText = this.targetText.slice(0, this.currentText.length + a), this.lastUpdateTime = e - t, (a === n || e - this.lastCommitTime >= this.minCommitMs) && (this.lastCommitTime = e, this.setText(this.currentText)));
	};
}, Tf = Object.freeze({ type: "running" }), Ef = (e, t) => e !== void 0 && e > 0 ? e : t, Df = (e, t = !1) => {
	let { text: n } = e, r = uf("(prefers-reduced-motion: reduce)"), i = typeof t == "object" && t ? t : void 0, a = t !== !1 && t !== null && !r, o = Ef(i?.drainMs, Sf), s = Ef(i?.maxCharIntervalMs, Cf), c = Ef(i?.maxCharsPerFrame, Infinity), l = Ef(i?.minCommitMs, 0), [u, d] = Qe(e.status.type === "running" ? "" : n), f = Kr(), p = B(() => f.part), [m, h] = Qe(p);
	(p !== m || !n.startsWith(u)) && (h(p), d(e.status.type === "running" ? "" : n));
	let g = xf({ optional: !0 }), _ = Kd((t) => {
		if (d(t), g) {
			let n = u !== t || e.status.type === "running" ? Tf : e.status;
			ad(g).setState(n, !0);
		}
	});
	R(() => {
		if (g) {
			let t = a && (u !== n || e.status.type === "running") ? Tf : e.status;
			ad(g).setState(t, !0);
		}
	}, [
		g,
		a,
		n,
		u,
		e.status
	]);
	let [v] = Qe(new wf(u, _));
	R(() => {
		v.drainMs = o, v.maxCharIntervalMs = s, v.maxCharsPerFrame = c, v.minCommitMs = l;
	}, [
		v,
		o,
		s,
		c,
		l
	]);
	let y = et(p);
	return R(() => {
		if (!a) {
			v.stop();
			return;
		}
		let t = y.current !== p;
		if (y.current = p, t || !n.startsWith(v.targetText)) {
			e.status.type === "running" ? (v.currentText = "", v.targetText = n, v.lastCommitTime = 0, v.start()) : (v.currentText = n, v.targetText = n, v.stop(), _(n));
			return;
		}
		if (v.targetText = n, e.status.type !== "running") {
			if (v.currentText === "") {
				v.currentText = n, v.stop(), _(n);
				return;
			}
			v.start();
			return;
		}
		v.start();
	}, [
		v,
		a,
		n,
		e.status.type,
		p,
		_
	]), R(() => () => {
		v.stop();
	}, [v]), tt(() => a ? {
		...e,
		text: u,
		status: n === u ? e.status : Tf
	} : e, [
		a,
		u,
		e,
		n
	]);
}, Of = Object.freeze({ type: "complete" }), kf = Object.freeze({
	type: "image",
	image: "",
	status: Of
}), Af = () => B(jf);
function jf(e) {
	return e.part.type === "image" ? e.part : kf;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/messagePart/MessagePartText.js
var Mf = lt(({ smooth: e = !0, component: t = tf.span, render: n, ...r }, i) => {
	let { text: a, status: o } = Df(pf(), e), s = {
		"data-status": o.type,
		...r,
		ref: i
	};
	return n && mt(n) ? Qd(n, a, s) : /* @__PURE__ */ (0, H.jsx)(t, {
		...s,
		children: a
	});
});
Mf.displayName = "MessagePartPrimitive.Text";
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/messagePart/MessagePartImage.js
var Nf = lt((e, t) => {
	let n = N(4), { image: r } = Af(), i;
	return n[0] !== t || n[1] !== r || n[2] !== e ? (i = /* @__PURE__ */ (0, H.jsx)(tf.img, {
		src: r,
		...e,
		ref: t
	}), n[0] = t, n[1] = r, n[2] = e, n[3] = i) : i = n[3], i;
});
Nf.displayName = "MessagePartPrimitive.Image";
//#endregion
//#region node_modules/@assistant-ui/react/dist/utils/hooks/useManagedRef.js
var Pf = (e) => {
	let t = N(2), n = et(void 0), r;
	return t[0] === e ? r = t[1] : (r = (t) => {
		n.current &&= (n.current(), void 0), t && (n.current = e(t));
	}, t[0] = e, t[1] = r), r;
}, Ff = (e, t) => {
	let n = e.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(em|px|rem)$/);
	if (!n) return Infinity;
	let r = Number(n[1]), i = n[2];
	return i === "px" ? r : i === "em" ? r * (parseFloat(getComputedStyle(t).fontSize) || 16) : i === "rem" ? r * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) : Infinity;
}, If = (e) => e.dataset.messageId, Lf = () => {
	let e = document.createElement("div");
	return e.dataset.auiTopAnchorReserve = "", e.style.height = "0px", e.style.flexShrink = "0", e.style.pointerEvents = "none", e.setAttribute("aria-hidden", "true"), e;
}, Rf = (e, t) => {
	let n = `${t}px`;
	return e.style.height !== n && (e.style.height = n, !0);
}, zf = (e) => {
	let t = window.devicePixelRatio || 1;
	return Math.round(e * t) / t;
}, Bf = () => {
	let e = N(4), t = Kr(), n;
	e[0] === t.message ? n = e[1] : (n = () => t.message, e[0] = t.message, e[1] = n);
	let r = B(n), i;
	return e[2] === r ? i = e[3] : (i = (e) => {
		let t = () => {
			r.setIsHovering(!0);
		}, n = () => {
			r.setIsHovering(!1);
		};
		return e.addEventListener("mouseenter", t), e.addEventListener("mouseleave", n), e.matches(":hover") && queueMicrotask(() => r.setIsHovering(!0)), () => {
			e.removeEventListener("mouseenter", t), e.removeEventListener("mouseleave", n), r.setIsHovering(!1);
		};
	}, e[2] = r, e[3] = i), Pf(i);
}, Vf = () => {
	let e = N(2), t = Qu(qf), n;
	return e[0] === t ? n = e[1] : (n = (e) => e.message.role === "user" && e.message.index > 0 && e.message.index === e.thread.messages.length - 2 && e.thread.messages.at(-1)?.role === "assistant" && (e.message.id === t || e.thread.isRunning), e[0] = t, e[1] = n), B(n);
}, Hf = () => {
	let e = N(2), t = Qu(Jf), n;
	return e[0] === t ? n = e[1] : (n = (e) => e.message.isLast && e.message.role === "assistant" && e.message.index >= 1 && e.thread.messages.at(e.message.index - 1)?.role === "user" && (e.message.id === t || e.thread.isRunning), e[0] = t, e[1] = n), B(n);
}, Uf = (e, t) => {
	let n = N(3), r;
	return n[0] !== e || n[1] !== t ? (r = (n) => {
		if (e) return t.getState().registerAnchorElement(n);
	}, n[0] = e, n[1] = t, n[2] = r) : r = n[2], Pf(r);
}, Wf = (e) => {
	let t = N(3), { active: n, threadViewportStore: r } = e, i;
	return t[0] !== n || t[1] !== r ? (i = (e) => {
		if (!n) return;
		let t = r.getState(), i = t.topAnchorMessageClamp;
		return t.registerAnchorTargetElement(e, {
			tallerThan: Ff(i.tallerThan, e),
			visibleHeight: Ff(i.visibleHeight, e)
		});
	}, t[0] = n, t[1] = r, t[2] = i) : i = t[2], Pf(i);
}, Gf = (e) => {
	let t = N(7), n, r;
	t[0] === e ? (n = t[1], r = t[2]) : ({forwardedRef: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r);
	let i = Bf(), a = md(n, i), o = B(Yf), s;
	return t[3] !== o || t[4] !== r || t[5] !== a ? (s = /* @__PURE__ */ (0, H.jsx)(tf.div, {
		...r,
		ref: a,
		"data-message-id": o
	}), t[3] = o, t[4] = r, t[5] = a, t[6] = s) : s = t[6], s;
}, J = (e) => {
	let t = N(13), n, r, i;
	t[0] === e ? (n = t[1], r = t[2], i = t[3]) : ({forwardedRef: n, threadViewportStore: i, ...r} = e, t[0] = e, t[1] = n, t[2] = r, t[3] = i);
	let a = Bf(), o = Vf(), s = Hf(), c = Uf(o, i), l;
	t[4] !== s || t[5] !== i ? (l = {
		active: s,
		threadViewportStore: i
	}, t[4] = s, t[5] = i, t[6] = l) : l = t[6];
	let u = Wf(l), d = md(n, a, c, u), f = B(Xf), p = o ? "" : void 0, m = s ? "" : void 0, h;
	return t[7] !== f || t[8] !== r || t[9] !== d || t[10] !== p || t[11] !== m ? (h = /* @__PURE__ */ (0, H.jsx)(tf.div, {
		...r,
		ref: d,
		"data-message-id": f,
		"data-aui-top-anchor-user": p,
		"data-aui-top-anchor-target": m
	}), t[7] = f, t[8] = r, t[9] = d, t[10] = p, t[11] = m, t[12] = h) : h = t[12], h;
}, Kf = lt((e, t) => {
	let n = N(7), r = $u();
	if (r.getState().turnAnchor === "top") {
		let i;
		return n[0] !== t || n[1] !== e || n[2] !== r ? (i = /* @__PURE__ */ (0, H.jsx)(J, {
			...e,
			forwardedRef: t,
			threadViewportStore: r
		}), n[0] = t, n[1] = e, n[2] = r, n[3] = i) : i = n[3], i;
	}
	let i;
	return n[4] !== t || n[5] !== e ? (i = /* @__PURE__ */ (0, H.jsx)(Gf, {
		...e,
		forwardedRef: t
	}), n[4] = t, n[5] = e, n[6] = i) : i = n[6], i;
});
Kf.displayName = "MessagePrimitive.Root";
function qf(e) {
	return e.topAnchorTurn?.anchorId;
}
function Jf(e) {
	return e.topAnchorTurn?.targetId;
}
function Yf(e) {
	return e.message.id;
}
function Xf(e) {
	return e.message.id;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/message/MessageParts.js
var Zf = {
	...Ul,
	Text: () => /* @__PURE__ */ (0, H.jsxs)("p", {
		style: { whiteSpace: "pre-line" },
		children: [/* @__PURE__ */ (0, H.jsx)(Mf, {}), /* @__PURE__ */ (0, H.jsx)(Iu, { children: /* @__PURE__ */ (0, H.jsx)("span", {
			style: { fontFamily: "revert" },
			children: " ●"
		}) })]
	}),
	Image: () => /* @__PURE__ */ (0, H.jsx)(Nf, {})
}, Qf = (e) => {
	let t = N(10);
	if ("children" in e) {
		let n;
		return t[0] === e.children ? n = t[1] : (n = /* @__PURE__ */ (0, H.jsx)(W, { children: e.children }), t[0] = e.children, t[1] = n), n;
	}
	let n, r;
	t[2] === e ? (n = t[3], r = t[4]) : ({components: n, ...r} = e, t[2] = e, t[3] = n, t[4] = r);
	let i;
	t[5] === n ? i = t[6] : (i = n ? {
		...n,
		Text: n.Text ?? Zf.Text,
		Image: n.Image ?? Zf.Image
	} : Zf, t[5] = n, t[6] = i);
	let a = i, o;
	return t[7] !== r || t[8] !== a ? (o = /* @__PURE__ */ (0, H.jsx)(W, {
		components: a,
		...r
	}), t[7] = r, t[8] = a, t[9] = o) : o = t[9], o;
};
Qf.displayName = "MessagePrimitive.Parts";
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/message/MessageIf.js
var $f = (e) => {
	let t = N(12), n;
	return t[0] !== e.assistant || t[1] !== e.copied || t[2] !== e.hasAttachments || t[3] !== e.hasBranches || t[4] !== e.hasContent || t[5] !== e.last || t[6] !== e.lastOrHover || t[7] !== e.speaking || t[8] !== e.submittedFeedback || t[9] !== e.system || t[10] !== e.user ? (n = (t) => {
		let { role: n, attachments: r, parts: i, branchCount: a, isLast: o, speech: s, isCopied: c, isHovering: l } = t.message;
		return !(e.hasBranches === !0 && a < 2 || e.user && n !== "user" || e.assistant && n !== "assistant" || e.system && n !== "system" || e.lastOrHover === !0 && !l && !o || e.last !== void 0 && e.last !== o || e.copied === !0 && !c || e.copied === !1 && c || e.speaking === !0 && s == null || e.speaking === !1 && s != null || e.hasAttachments === !0 && (n !== "user" || !r?.length) || e.hasAttachments === !1 && n === "user" && r?.length || e.hasContent === !0 && i.length === 0 || e.hasContent === !1 && i.length > 0 || e.submittedFeedback !== void 0 && (t.message.metadata.submittedFeedback?.type ?? null) !== e.submittedFeedback);
	}, t[0] = e.assistant, t[1] = e.copied, t[2] = e.hasAttachments, t[3] = e.hasBranches, t[4] = e.hasContent, t[5] = e.last, t[6] = e.lastOrHover, t[7] = e.speaking, t[8] = e.submittedFeedback, t[9] = e.system, t[10] = e.user, t[11] = n) : n = t[11], B(n);
}, ep = (e) => {
	let t = N(3), n, r;
	return t[0] === e ? (n = t[1], r = t[2]) : ({children: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r), $f(r) ? n : null;
};
ep.displayName = "MessagePrimitive.If";
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/message/MessageError.js
var tp = (e) => {
	let { children: t } = e;
	return qu() === void 0 ? null : t;
};
tp.displayName = "MessagePrimitive.Error";
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/message/MessagePartsGrouped.js
var np = (e) => {
	let t = /* @__PURE__ */ new Map();
	for (let n = 0; n < e.length; n++) {
		let r = e[n]?.parentId ?? n, i = t.get(r) ?? [];
		i.push(n), t.set(r, i);
	}
	let n = [];
	for (let [e, r] of t) {
		let t = typeof e == "string" ? e : void 0;
		n.push({
			groupKey: t,
			indices: r
		});
	}
	return n;
}, rp = (e) => {
	let t = N(4), n = B(mp), r;
	bb0: {
		if (n.length === 0) {
			let e;
			t[0] === Symbol.for("react.memo_cache_sentinel") ? (e = [], t[0] = e) : e = t[0], r = e;
			break bb0;
		}
		let i;
		t[1] !== e || t[2] !== n ? (i = e(n), t[1] = e, t[2] = n, t[3] = i) : i = t[3], r = i;
	}
	return r;
}, ip = (e) => {
	let t = N(9), n, r;
	t[0] === e ? (n = t[1], r = t[2]) : ({Fallback: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r);
	let i;
	t[3] !== n || t[4] !== r.toolName ? (i = (e) => e.tools.toolUIs[r.toolName]?.[0]?.render ?? n, t[3] = n, t[4] = r.toolName, t[5] = i) : i = t[5];
	let a = B(i);
	if (!a) return null;
	let o;
	return t[6] !== a || t[7] !== r ? (o = /* @__PURE__ */ (0, H.jsx)(a, { ...r }), t[6] = a, t[7] = r, t[8] = o) : o = t[8], o;
}, ap = (e) => {
	let t = N(9), n, r;
	t[0] === e ? (n = t[1], r = t[2]) : ({Fallback: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r);
	let i;
	t[3] !== n || t[4] !== r.name ? (i = (e) => {
		let t = e.dataRenderers.renderers[r.name] ?? n;
		return Array.isArray(t) ? t[0] ?? n : t;
	}, t[3] = n, t[4] = r.name, t[5] = i) : i = t[5];
	let a = B(i);
	if (!a) return null;
	let o;
	return t[6] !== a || t[7] !== r ? (o = /* @__PURE__ */ (0, H.jsx)(a, { ...r }), t[6] = a, t[7] = r, t[8] = o) : o = t[8], o;
}, op = {
	Text: () => /* @__PURE__ */ (0, H.jsxs)("p", {
		style: { whiteSpace: "pre-line" },
		children: [/* @__PURE__ */ (0, H.jsx)(Mf, {}), /* @__PURE__ */ (0, H.jsx)(Iu, { children: /* @__PURE__ */ (0, H.jsx)("span", {
			style: { fontFamily: "revert" },
			children: " ●"
		}) })]
	}),
	Reasoning: () => null,
	Source: () => null,
	Image: () => /* @__PURE__ */ (0, H.jsx)(Nf, {}),
	File: () => null,
	Unstable_Audio: () => null,
	Group: ({ children: e }) => e
}, sp = (e) => {
	let t = N(37), { components: n } = e, r;
	t[0] === n ? r = t[1] : (r = n === void 0 ? {} : n, t[0] = n, t[1] = r);
	let { Text: i, Reasoning: a, Image: o, Source: s, File: c, Unstable_Audio: l, tools: u, data: d } = r, f = i === void 0 ? op.Text : i, p = a === void 0 ? op.Reasoning : a, m = o === void 0 ? op.Image : o, h = s === void 0 ? op.Source : s, g = c === void 0 ? op.File : c, _ = l === void 0 ? op.Unstable_Audio : l, v;
	t[2] === u ? v = t[3] : (v = u === void 0 ? {} : u, t[2] = u, t[3] = v);
	let y = v, b = Kr(), x = B(hp), S = x.type;
	if (S === "tool-call") {
		let e = b.part.addToolResult, n = b.part.resumeToolCall, r = b.part.respondToToolApproval;
		if ("Override" in y) {
			let i;
			return t[4] !== e || t[5] !== x || t[6] !== r || t[7] !== n || t[8] !== y.Override ? (i = /* @__PURE__ */ (0, H.jsx)(y.Override, {
				...x,
				addResult: e,
				resume: n,
				respondToApproval: r
			}), t[4] = e, t[5] = x, t[6] = r, t[7] = n, t[8] = y.Override, t[9] = i) : i = t[9], i;
		}
		let i = y.by_name?.[x.toolName] ?? y.Fallback, a;
		return t[10] !== i || t[11] !== e || t[12] !== x || t[13] !== r || t[14] !== n ? (a = /* @__PURE__ */ (0, H.jsx)(ip, {
			...x,
			Fallback: i,
			addResult: e,
			resume: n,
			respondToApproval: r
		}), t[10] = i, t[11] = e, t[12] = x, t[13] = r, t[14] = n, t[15] = a) : a = t[15], a;
	}
	if (x.status?.type === "requires-action") throw Error("Encountered unexpected requires-action status");
	switch (S) {
		case "text": {
			let e;
			return t[16] !== f || t[17] !== x ? (e = /* @__PURE__ */ (0, H.jsx)(f, { ...x }), t[16] = f, t[17] = x, t[18] = e) : e = t[18], e;
		}
		case "reasoning": {
			let e;
			return t[19] !== p || t[20] !== x ? (e = /* @__PURE__ */ (0, H.jsx)(p, { ...x }), t[19] = p, t[20] = x, t[21] = e) : e = t[21], e;
		}
		case "source": {
			let e;
			return t[22] !== h || t[23] !== x ? (e = /* @__PURE__ */ (0, H.jsx)(h, { ...x }), t[22] = h, t[23] = x, t[24] = e) : e = t[24], e;
		}
		case "image": {
			let e;
			return t[25] !== m || t[26] !== x ? (e = /* @__PURE__ */ (0, H.jsx)(m, { ...x }), t[25] = m, t[26] = x, t[27] = e) : e = t[27], e;
		}
		case "file": {
			let e;
			return t[28] !== g || t[29] !== x ? (e = /* @__PURE__ */ (0, H.jsx)(g, { ...x }), t[28] = g, t[29] = x, t[30] = e) : e = t[30], e;
		}
		case "audio": {
			let e;
			return t[31] !== _ || t[32] !== x ? (e = /* @__PURE__ */ (0, H.jsx)(_, { ...x }), t[31] = _, t[32] = x, t[33] = e) : e = t[33], e;
		}
		case "data": {
			let e = d?.by_name?.[x.name] ?? d?.Fallback, n;
			return t[34] !== e || t[35] !== x ? (n = /* @__PURE__ */ (0, H.jsx)(ap, {
				...x,
				Fallback: e
			}), t[34] = e, t[35] = x, t[36] = n) : n = t[36], n;
		}
		default: return console.warn(`Unknown message part type: ${S}`), null;
	}
}, cp = ut((e) => {
	let t = N(5), { partIndex: n, components: r } = e, i;
	t[0] === r ? i = t[1] : (i = /* @__PURE__ */ (0, H.jsx)(sp, { components: r }), t[0] = r, t[1] = i);
	let a;
	return t[2] !== n || t[3] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(Ms, {
		index: n,
		children: i
	}), t[2] = n, t[3] = i, t[4] = a) : a = t[4], a;
}, (e, t) => e.partIndex === t.partIndex && e.components?.Text === t.components?.Text && e.components?.Reasoning === t.components?.Reasoning && e.components?.Source === t.components?.Source && e.components?.Image === t.components?.Image && e.components?.File === t.components?.File && e.components?.Unstable_Audio === t.components?.Unstable_Audio && e.components?.tools === t.components?.tools && e.components?.data === t.components?.data && e.components?.Group === t.components?.Group), lp = (e) => {
	let t = N(6), { status: n, component: r } = e, i = n.type === "running", a;
	t[0] !== r || t[1] !== n ? (a = /* @__PURE__ */ (0, H.jsx)(r, {
		type: "text",
		text: "",
		status: n
	}), t[0] = r, t[1] = n, t[2] = a) : a = t[2];
	let o;
	return t[3] !== i || t[4] !== a ? (o = /* @__PURE__ */ (0, H.jsx)(Ps, {
		text: "",
		isRunning: i,
		children: a
	}), t[3] = i, t[4] = a, t[5] = o) : o = t[5], o;
}, up = Object.freeze({ type: "complete" }), dp = ut((e) => {
	let t = N(6), { components: n } = e, r = B(gp);
	if (n?.Empty) {
		let e;
		return t[0] !== n.Empty || t[1] !== r ? (e = /* @__PURE__ */ (0, H.jsx)(n.Empty, { status: r }), t[0] = n.Empty, t[1] = r, t[2] = e) : e = t[2], e;
	}
	let i = n?.Text ?? op.Text, a;
	return t[3] !== r || t[4] !== i ? (a = /* @__PURE__ */ (0, H.jsx)(lp, {
		status: r,
		component: i
	}), t[3] = r, t[4] = i, t[5] = a) : a = t[5], a;
}, (e, t) => e.components?.Empty === t.components?.Empty && e.components?.Text === t.components?.Text), fp = (e) => {
	let t = N(9), { groupingFunction: n, components: r } = e, i = B(_p), a = rp(n), o;
	bb0: {
		if (i === 0) {
			let e;
			t[0] === r ? e = t[1] : (e = /* @__PURE__ */ (0, H.jsx)(dp, { components: r }), t[0] = r, t[1] = e), o = e;
			break bb0;
		}
		let e;
		if (t[2] !== r || t[3] !== a) {
			let n;
			t[5] === r ? n = t[6] : (n = (e, t) => {
				let n = r?.Group ?? op.Group;
				return /* @__PURE__ */ (0, H.jsx)(n, {
					groupKey: e.groupKey,
					indices: e.indices,
					children: e.indices.map((e) => /* @__PURE__ */ (0, H.jsx)(cp, {
						partIndex: e,
						components: r
					}, e))
				}, `group-${t}-${e.groupKey ?? "ungrouped"}`);
			}, t[5] = r, t[6] = n), e = a.map(n), t[2] = r, t[3] = a, t[4] = e;
		} else e = t[4];
		o = e;
	}
	let s = o, c;
	return t[7] === s ? c = t[8] : (c = /* @__PURE__ */ (0, H.jsx)(H.Fragment, { children: s }), t[7] = s, t[8] = c), c;
};
fp.displayName = "MessagePrimitive.Unstable_PartsGrouped";
var pp = (e) => {
	let t = N(6), n, r;
	t[0] === e ? (n = t[1], r = t[2]) : ({components: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r);
	let i;
	return t[3] !== n || t[4] !== r ? (i = /* @__PURE__ */ (0, H.jsx)(fp, {
		...r,
		components: n,
		groupingFunction: np
	}), t[3] = n, t[4] = r, t[5] = i) : i = t[5], i;
};
pp.displayName = "MessagePrimitive.Unstable_PartsGroupedByParentId";
function mp(e) {
	return e.message.parts;
}
function hp(e) {
	return e.part;
}
function gp(e) {
	return e.message.status ?? up;
}
function _p(e) {
	return e.message.parts.length;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/message.js
var vp = /* @__PURE__ */ Yd({
	AttachmentByIndex: () => Mu,
	Attachments: () => Pu,
	Content: () => Qf,
	Error: () => tp,
	GenerativeUI: () => Fl,
	GroupedParts: () => Ou,
	If: () => ep,
	PartByIndex: () => Gl,
	Parts: () => Qf,
	Quote: () => ku,
	Root: () => Kf,
	Unstable_PartsGrouped: () => fp,
	Unstable_PartsGroupedByParentId: () => pp
}), yp = (e) => {
	let t = N(2), n = Kd(e), r;
	return t[0] === n ? r = t[1] : (r = (e) => {
		let t = new ResizeObserver(() => {
			n();
		}), r = new MutationObserver((e) => {
			e.some(bp) && n();
		});
		return t.observe(e), r.observe(e, {
			childList: !0,
			subtree: !0,
			attributes: !0,
			characterData: !0
		}), () => {
			t.disconnect(), r.disconnect();
		};
	}, t[0] = n, t[1] = r), Pf(r);
};
function bp(e) {
	return e.type !== "attributes" || e.attributeName !== "style";
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/thread/useThreadViewportAutoScroll.js
var xp = ({ autoScroll: e, scrollToBottomOnRunStart: t = !0, scrollToBottomOnInitialize: n = !0, scrollToBottomOnThreadSwitch: r = !0 }) => {
	let i = et(null), a = B((e) => e.thread.messages.length > 0), o = B((e) => e.thread.isRunning), s = et(!1), c = et(null), l = $u();
	e === void 0 && (e = l.getState().turnAnchor !== "top");
	let u = et(0), d = et(0), f = et(0), p = et(0), m = et(null), h = et(e), g = et(e);
	rt(() => {
		let t = g.current;
		if (g.current = e, t || !e) return;
		let n = i.current;
		h.current = n !== null && ai(n);
	}, [e]);
	let _ = nt((e) => {
		let t = i.current;
		t && (h.current = !0, m.current = e, t.scrollTo({
			top: t.scrollHeight,
			behavior: e
		}));
	}, []), v = nt(() => {
		c.current !== null && (cancelAnimationFrame(c.current), c.current = null);
	}, []), y = nt((e) => {
		m.current = e, v(), c.current = requestAnimationFrame(() => {
			c.current = null, _(e);
		});
	}, [v, _]);
	rt(() => () => v(), [v]);
	let b = nt(() => {
		let e = l.getState();
		return e.turnAnchor === "top" && e.element.viewport === i.current && e.element.anchor !== null;
	}, [l]), x = () => {
		let t = i.current;
		if (!t) return;
		let n = l.getState().isAtBottom, r = ai(t);
		if (!(!r && u.current < t.scrollTop)) {
			let i = si({
				scrollTop: u.current,
				scrollHeight: d.current
			}, t);
			r ? (oi(t) && (m.current = null), e && (h.current = !0)) : i && (v(), m.current = null, h.current = !1), (r || m.current === null) && r !== n && ad(l).setState({ isAtBottom: r });
		}
		u.current = t.scrollTop, d.current = t.scrollHeight;
	}, S = yp(() => {
		let t = i.current;
		if (!t) return;
		let { scrollHeight: n, clientHeight: r } = t;
		if (n === f.current && r === p.current) return;
		f.current = n, p.current = r;
		let a = m.current;
		a && b() ? m.current = null : a ? _(a) : e && !(o && b()) && h.current && _("instant"), x();
	}), C = Pf((e) => {
		let t = () => {
			m.current = null;
		};
		return e.addEventListener("scroll", x), e.addEventListener("pointerdown", t), () => {
			e.removeEventListener("scroll", x), e.removeEventListener("pointerdown", t);
		};
	});
	return rt(() => {
		if (n) {
			if (!a) {
				s.current = !1;
				return;
			}
			s.current || (s.current = !0, m.current === null && y("instant"));
		}
	}, [
		a,
		y,
		n
	]), of(({ behavior: e }) => {
		_(e);
	}), Aa("thread.runStart", () => {
		t && l.getState().turnAnchor !== "top" && y("auto");
	}), Aa("threads.selectionChanged", () => {
		r && y("instant");
	}), md(S, C, i);
}, Sp = lt((e, t) => {
	let n = N(6), r = Kr(), i, a;
	n[0] === r ? (i = n[1], a = n[2]) : (i = () => {
		let e = (e) => {
			if (e.key === "Escape" && !(e.defaultPrevented || r.thread.source === null) && r.thread.getState().speech != null) {
				e.preventDefault();
				try {
					r.thread.stopSpeaking();
				} catch (e) {
					let t = e;
					if (!(t instanceof Error) || t.message !== "No message is being spoken") throw t;
				}
			}
		};
		return document.addEventListener("keydown", e), () => {
			document.removeEventListener("keydown", e);
		};
	}, a = [r], n[0] = r, n[1] = i, n[2] = a), R(i, a);
	let o;
	return n[3] !== e || n[4] !== t ? (o = /* @__PURE__ */ (0, H.jsx)(tf.div, {
		...e,
		ref: t
	}), n[3] = e, n[4] = t, n[5] = o) : o = n[5], o;
});
Sp.displayName = "ThreadPrimitive.Root";
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/thread/ThreadEmpty.js
var Cp = (e) => {
	let { children: t } = e;
	return B(wp) ? t : null;
};
Cp.displayName = "ThreadPrimitive.Empty";
function wp(e) {
	return e.thread.isEmpty;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/thread/ThreadIf.js
var Tp = (e) => {
	let t = N(4), n;
	return t[0] !== e.disabled || t[1] !== e.empty || t[2] !== e.running ? (n = (t) => !(e.empty === !0 && !t.thread.isEmpty || e.empty === !1 && t.thread.isEmpty || e.running === !0 && !t.thread.isRunning || e.running === !1 && t.thread.isRunning || e.disabled === !0 && !t.thread.isDisabled || e.disabled === !1 && t.thread.isDisabled), t[0] = e.disabled, t[1] = e.empty, t[2] = e.running, t[3] = n) : n = t[3], B(n);
}, Ep = (e) => {
	let t = N(3), n, r;
	return t[0] === e ? (n = t[1], r = t[2]) : ({children: n, ...r} = e, t[0] = e, t[1] = n, t[2] = r), Tp(r) ? n : null;
};
Ep.displayName = "ThreadPrimitive.If";
//#endregion
//#region node_modules/@assistant-ui/react/dist/utils/hooks/useSizeHandle.js
var Dp = (e, t) => {
	let n = N(3), r;
	return n[0] !== t || n[1] !== e ? (r = (n) => {
		if (!e) return;
		let r = e(), i = () => {
			let e = t ? t(n) : n.offsetHeight;
			r.setHeight(e);
		}, a = new ResizeObserver(i);
		return a.observe(n), i(), () => {
			a.disconnect(), r.unregister();
		};
	}, n[0] = t, n[1] = e, n[2] = r) : r = n[2], Pf(r);
}, Op = (e) => {
	let t = 0, n = e;
	for (; n;) t += n.offsetTop, n = n.offsetParent;
	return t;
}, kp = (e, t) => {
	let n = 0, r = e;
	for (; r && r !== t;) n += r.offsetTop, r = r.offsetParent;
	return r === t ? n : Op(e) - Op(t);
}, Ap = ({ viewport: e, anchor: t, tallerThan: n, visibleHeight: r }) => {
	let i = kp(t, e), a = t.offsetHeight;
	return i + Math.max(0, a - (a <= n ? a : r));
}, jp = ({ scrollHeight: e, ...t }) => {
	let { viewport: n } = t, r = Ap(t) + n.clientHeight;
	return Math.max(0, r - e);
}, Mp = ({ viewport: e, reserve: t, ...n }) => jp({
	viewport: e,
	...n,
	scrollHeight: e.scrollHeight - t.offsetHeight
}), Np = (e) => {
	let t = new ResizeObserver(e), n = new MutationObserver(e), r = null, i = null, a = null, o = () => {
		t.disconnect(), n.disconnect(), r = null, i = null, a = null;
	};
	return {
		target: (e, s, c) => {
			(r !== e || i !== s || a !== c) && (o(), t.observe(e), t.observe(s), t.observe(c), n.observe(c, {
				childList: !0,
				subtree: !0,
				characterData: !0
			}), r = e, i = s, a = c);
		},
		disconnect: o
	};
}, Pp = (e) => {
	let t = null;
	return {
		schedule: () => {
			t === null && (t = requestAnimationFrame(() => {
				t = null, e();
			}));
		},
		cancel: () => {
			t !== null && (cancelAnimationFrame(t), t = null);
		}
	};
}, Fp = (e) => {
	let t = null, n;
	function r() {
		let r = e.getState(), { viewport: o, anchor: s, target: c } = r.element, l = r.targetConfig;
		if (r.turnAnchor !== "top" || !o) {
			a.disconnect(), t && (Rf(t, 0), t.remove());
			return;
		}
		if (!s && !c && !l && r.topAnchorTurn) {
			a.disconnect(), t?.parentElement && t.parentElement.lastElementChild !== t && t.parentElement.append(t);
			return;
		}
		if (!s || !c || !l) {
			a.disconnect(), t && (Rf(t, 0), t.remove());
			return;
		}
		if (t ??= Lf(), (t.parentElement !== c.parentElement || t.previousElementSibling !== c) && c.after(t), a.target(o, s, c), Rf(t, Mp({
			viewport: o,
			anchor: s,
			reserve: t,
			...l
		}))) {
			i.schedule();
			return;
		}
		let u = If(s);
		if (u !== void 0 && n === u) return;
		let d = zf(Ap({
			viewport: o,
			anchor: s,
			...l
		}));
		Math.abs(o.scrollTop - d) > 1 && o.scrollTo({
			top: d,
			behavior: "smooth"
		}), u !== void 0 && (n = u);
	}
	let i = Pp(r), a = Np(i.schedule);
	i.schedule();
	let o = e.subscribe(i.schedule);
	return () => {
		i.cancel(), o(), a.disconnect(), t?.remove();
	};
}, Ip = (e) => {
	let t = N(4), n = $u(), r, i;
	t[0] !== e || t[1] !== n ? (r = () => {
		if (e) return Fp(n);
	}, i = [e, n], t[0] = e, t[1] = n, t[2] = r, t[3] = i) : (r = t[2], i = t[3]), rt(r, i);
}, Lp = (e, t) => {
	if (!e) return !1;
	let n = t.findIndex((t) => t.id === e.targetId);
	return n < 1 ? !1 : t[n - 1]?.id === e.anchorId && t.slice(n + 1).every((e) => e.role === "user");
}, Rp = ({ isRunning: e, messages: t }) => {
	if (!e) return null;
	let n = t.at(-1), r = t.at(-2);
	return r?.role !== "user" || n?.role !== "assistant" ? null : {
		anchorId: r.id,
		targetId: n.id
	};
}, zp = (e) => Rp(e)?.anchorId, Bp = (e) => Rp(e)?.targetId, Vp = () => Dp(Qu(Kp), qp), Hp = () => Pf(Qu(Jp)), Up = (e) => {
	let t = N(19), n = $u(), r;
	t[0] === e ? r = t[1] : (r = (t) => {
		if (e) return zp(t.thread);
	}, t[0] = e, t[1] = r);
	let i = B(r), a;
	t[2] === e ? a = t[3] : (a = (t) => {
		if (e) return Bp(t.thread);
	}, t[2] = e, t[3] = a);
	let o = B(a), s = Qu(Yp), c;
	bb0: {
		if (!i || !o) {
			c = null;
			break bb0;
		}
		let e;
		t[4] !== i || t[5] !== o ? (e = {
			anchorId: i,
			targetId: o
		}, t[4] = i, t[5] = o, t[6] = e) : e = t[6], c = e;
	}
	let l = c, u;
	t[7] !== e || t[8] !== s ? (u = (t) => e && !!s && Lp(s, t.thread.messages), t[7] = e, t[8] = s, t[9] = u) : u = t[9];
	let d = B(u), f, p;
	t[10] !== n || t[11] !== s || t[12] !== d ? (f = () => {
		s && !d && n.getState().setTopAnchorTurn(null);
	}, p = [
		n,
		s,
		d
	], t[10] = n, t[11] = s, t[12] = d, t[13] = f, t[14] = p) : (f = t[13], p = t[14]), rt(f, p);
	let m, h;
	t[15] !== l || t[16] !== n ? (m = () => {
		if (!l) return;
		let e = n.getState(), t = e.topAnchorTurn;
		(t?.anchorId !== l.anchorId || t.targetId !== l.targetId) && e.setTopAnchorTurn(l);
	}, h = [l, n], t[15] = l, t[16] = n, t[17] = m, t[18] = h) : (m = t[17], h = t[18]), rt(m, h);
}, Wp = lt((e, t) => {
	let n = N(18), r, i, a, o, s, c;
	n[0] === e ? (r = n[1], i = n[2], a = n[3], o = n[4], s = n[5], c = n[6]) : ({autoScroll: r, scrollToBottomOnRunStart: s, scrollToBottomOnInitialize: o, scrollToBottomOnThreadSwitch: c, children: i, ...a} = e, n[0] = e, n[1] = r, n[2] = i, n[3] = a, n[4] = o, n[5] = s, n[6] = c);
	let l;
	n[7] !== r || n[8] !== o || n[9] !== s || n[10] !== c ? (l = {
		autoScroll: r,
		scrollToBottomOnRunStart: s,
		scrollToBottomOnInitialize: o,
		scrollToBottomOnThreadSwitch: c
	}, n[7] = r, n[8] = o, n[9] = s, n[10] = c, n[11] = l) : l = n[11];
	let u = xp(l), d = Vp(), f = Hp(), p = $u(), m;
	n[12] === p ? m = n[13] : (m = p.getState(), n[12] = p, n[13] = m);
	let h = m.turnAnchor === "top";
	Up(h), Ip(h);
	let g = md(t, u, d, f), _;
	return n[14] !== i || n[15] !== g || n[16] !== a ? (_ = /* @__PURE__ */ (0, H.jsx)(tf.div, {
		...a,
		ref: g,
		children: i
	}), n[14] = i, n[15] = g, n[16] = a, n[17] = _) : _ = n[17], _;
});
Wp.displayName = "ThreadPrimitive.ViewportScrollable";
var Gp = lt((e, t) => {
	let n = N(13), r, i, a;
	n[0] === e ? (r = n[1], i = n[2], a = n[3]) : ({turnAnchor: a, topAnchorMessageClamp: i, ...r} = e, n[0] = e, n[1] = r, n[2] = i, n[3] = a);
	let o;
	n[4] !== i || n[5] !== a ? (o = {
		turnAnchor: a,
		topAnchorMessageClamp: i
	}, n[4] = i, n[5] = a, n[6] = o) : o = n[6];
	let s;
	n[7] !== r || n[8] !== t ? (s = /* @__PURE__ */ (0, H.jsx)(Wp, {
		...r,
		ref: t
	}), n[7] = r, n[8] = t, n[9] = s) : s = n[9];
	let c;
	return n[10] !== o || n[11] !== s ? (c = /* @__PURE__ */ (0, H.jsx)(sd, {
		options: o,
		children: s
	}), n[10] = o, n[11] = s, n[12] = c) : c = n[12], c;
});
Gp.displayName = "ThreadPrimitive.Viewport";
function Kp(e) {
	return e.registerViewport;
}
function qp(e) {
	return e.clientHeight;
}
function Jp(e) {
	return e.registerViewportElement;
}
function Yp(e) {
	return e.topAnchorTurn;
}
//#endregion
//#region node_modules/@assistant-ui/react/dist/primitives/thread/ThreadViewportFooter.js
var Xp = lt((e, t) => {
	let n = N(3), r = md(t, Dp(Qu(Zp), Qp)), i;
	return n[0] !== e || n[1] !== r ? (i = /* @__PURE__ */ (0, H.jsx)(tf.div, {
		...e,
		ref: r
	}), n[0] = e, n[1] = r, n[2] = i) : i = n[2], i;
});
Xp.displayName = "ThreadPrimitive.ViewportFooter";
function Zp(e) {
	return e.registerContentInset;
}
function Qp(e) {
	let t = parseFloat(getComputedStyle(e).marginTop) || 0;
	return e.offsetHeight + t;
}
var $p = nf("ThreadPrimitive.ScrollToBottom", (e) => {
	let t = N(5), n;
	t[0] === e ? n = t[1] : (n = e === void 0 ? {} : e, t[0] = e, t[1] = n);
	let { behavior: r } = n, i = Qu(em), a = $u(), o;
	return t[2] !== r || t[3] !== a ? (o = () => {
		a.getState().scrollToBottom({ behavior: r });
	}, t[2] = r, t[3] = a, t[4] = o) : o = t[4], i ? null : o;
}, ["behavior"]);
function em(e) {
	return e.isAtBottom;
}
var tm = nf("ThreadPrimitive.Suggestion", (e) => {
	let t = N(4), { prompt: n, send: r, clearComposer: i, autoSend: a } = e, o = r ?? a ?? !1, s;
	t[0] !== i || t[1] !== n || t[2] !== o ? (s = {
		prompt: n,
		send: o,
		clearComposer: i
	}, t[0] = i, t[1] = n, t[2] = o, t[3] = s) : s = t[3];
	let { disabled: c, trigger: l } = Gu(s);
	return c ? null : l;
}, [
	"prompt",
	"send",
	"clearComposer",
	"autoSend",
	"method"
]), nm = /* @__PURE__ */ Yd({
	Empty: () => Cp,
	If: () => Ep,
	MessageByIndex: () => Sl,
	Messages: () => El,
	Root: () => Sp,
	ScrollToBottom: () => $p,
	Suggestion: () => tm,
	SuggestionByIndex: () => zu,
	Suggestions: () => Hu,
	Unstable_MessageById: () => Cl,
	Viewport: () => Gp,
	ViewportFooter: () => Xp,
	ViewportProvider: () => sd
}), rm = /* @__PURE__ */ Yd({
	AssistantRuntimeImpl: () => Tc,
	BaseAssistantRuntimeCore: () => Ac,
	CompositeContextProvider: () => vi,
	DefaultThreadComposerRuntimeCore: () => $c,
	MessageRepository: () => Vc,
	ThreadRuntimeImpl: () => vc,
	getAutoStatus: () => Ts,
	splitLocalRuntimeOptions: () => Ju,
	useComposerInputPluginRegistryOptional: () => af,
	useSmooth: () => Df,
	useSmoothStatus: () => bf,
	withSmoothContextProvider: () => vf
}), im = (e, t) => typeof e == "string" ? e === t : JSON.stringify(e) === JSON.stringify(t), am = (e, t) => {
	if (!e || !t) return !1;
	let n = (e) => {
		let { position: t, data: n, ...r } = e || {};
		return r;
	};
	return JSON.stringify(n(e.properties)) === JSON.stringify(n(t.properties)) && im(e.children, t.children);
}, om = (e, t) => am(e.node, t.node), sm = (0, j.createContext)(null), cm = () => (0, j.useContext)(sm) !== null, lm = (0, j.memo)(({ children: e, fallbackPre: t, ...n }) => n.node?.children.some((e) => e.type === "element" && e.tagName === "code") ?? !0 ? /* @__PURE__ */ (0, H.jsx)(sm.Provider, {
	value: n,
	children: e
}) : /* @__PURE__ */ (0, H.jsx)(t, {
	...n,
	children: e
}), (e, t) => e.fallbackPre === t.fallbackPre && om(e, t)), um = ({ node: e, ...t }) => /* @__PURE__ */ (0, H.jsx)("pre", { ...t }), dm = ({ node: e, ...t }) => /* @__PURE__ */ (0, H.jsx)("code", { ...t }), fm = ({ node: e, components: { Pre: t, Code: n }, code: r }) => /* @__PURE__ */ (0, H.jsx)(t, { children: /* @__PURE__ */ (0, H.jsx)(n, {
	node: e,
	children: r
}) }), pm = () => null, mm = (e) => /language-([^\s]+)/.exec(e ?? "")?.[1] ?? "", hm = ({ node: e, components: { Pre: t, Code: n, SyntaxHighlighter: r, CodeHeader: i }, language: a, code: o }) => {
	let s = (0, j.useMemo)(() => ({
		Pre: t,
		Code: n
	}), [t, n]);
	return /* @__PURE__ */ (0, H.jsxs)(H.Fragment, { children: [/* @__PURE__ */ (0, H.jsx)(i, {
		node: e,
		language: a,
		code: o
	}), /* @__PURE__ */ (0, H.jsx)(r, {
		node: e,
		components: s,
		language: a,
		code: o
	})] });
}, gm = /* @__PURE__ */ l((/* @__PURE__ */ o(((e, t) => {
	(function() {
		var e = {}.hasOwnProperty;
		function n() {
			for (var e = "", t = 0; t < arguments.length; t++) {
				var n = arguments[t];
				n && (e = i(e, r(n)));
			}
			return e;
		}
		function r(t) {
			if (typeof t == "string" || typeof t == "number") return t;
			if (typeof t != "object") return "";
			if (Array.isArray(t)) return n.apply(null, t);
			if (t.toString !== Object.prototype.toString && !t.toString.toString().includes("[native code]")) return t.toString();
			var r = "";
			for (var a in t) e.call(t, a) && t[a] && (r = i(r, a));
			return r;
		}
		function i(e, t) {
			return t ? e ? e + " " + t : e + t : e;
		}
		t !== void 0 && t.exports ? (n.default = n, t.exports = n) : typeof define == "function" && typeof define.amd == "object" && define.amd ? define("classnames", [], function() {
			return n;
		}) : window.classNames = n;
	})();
})))(), 1), _m = ({ className: e, ...t }) => ({ className: n, ...r }) => ({
	className: (0, gm.default)(e, n),
	...t,
	...r
});
//#endregion
//#region node_modules/@assistant-ui/react-markdown/dist/overrides/CodeOverride.js
function vm(e) {
	if (typeof e == "string") return e;
	if (Array.isArray(e)) {
		let t = "";
		for (let n of e) t += vm(n);
		return t;
	}
	return (0, j.isValidElement)(e) ? vm(e.props.children) : "";
}
var ym = ({ node: e, components: { Pre: t, Code: n, SyntaxHighlighter: r, CodeHeader: i }, componentsByLanguage: a = {}, children: o, ...s }) => {
	let c = _m((0, j.useContext)(sm)), l = Kd((e) => /* @__PURE__ */ (0, H.jsx)(t, { ...c(e) })), u = _m(s), d = Kd((e) => /* @__PURE__ */ (0, H.jsx)(n, { ...u(e) })), f = mm(s.className), p = a[f]?.SyntaxHighlighter ?? r, m = a[f]?.CodeHeader ?? i;
	return o != null && typeof o != "string" ? /* @__PURE__ */ (0, H.jsxs)(H.Fragment, { children: [/* @__PURE__ */ (0, H.jsx)(m, {
		node: e,
		language: f,
		code: vm(o)
	}), /* @__PURE__ */ (0, H.jsx)(fm, {
		node: e,
		components: {
			Pre: l,
			Code: d
		},
		code: o
	})] }) : /* @__PURE__ */ (0, H.jsx)(hm, {
		node: e,
		components: {
			Pre: l,
			Code: d,
			SyntaxHighlighter: p,
			CodeHeader: m
		},
		language: f,
		code: o ?? ""
	});
}, bm = ({ node: e, components: t, componentsByLanguage: n, ...r }) => cm() ? /* @__PURE__ */ (0, H.jsx)(ym, {
	node: e,
	components: t,
	componentsByLanguage: n,
	...r
}) : /* @__PURE__ */ (0, H.jsx)(t.Code, { ...r }), xm = (e, t) => {
	if (e === t) return !0;
	if (!e || !t) return !1;
	let n = Object.keys(e);
	if (n.length !== Object.keys(t).length) return !1;
	for (let r of n) {
		if (!Object.hasOwn(t, r)) return !1;
		let n = e[r], i = t[r];
		if (n !== i && (!n || !i || n.SyntaxHighlighter !== i.SyntaxHighlighter || n.CodeHeader !== i.CodeHeader)) return !1;
	}
	return !0;
}, Sm = (0, j.memo)(bm, (e, t) => e.components === t.components && xm(e.componentsByLanguage, t.componentsByLanguage) && om(e, t));
//#endregion
//#region node_modules/comma-separated-tokens/index.js
function Cm(e, t) {
	let n = t || {};
	return (e[e.length - 1] === "" ? [...e, ""] : e).join((n.padRight ? " " : "") + "," + (n.padLeft === !1 ? "" : " ")).trim();
}
//#endregion
//#region node_modules/estree-util-is-identifier-name/lib/index.js
var wm = /^[$_\p{ID_Start}][$_\u{200C}\u{200D}\p{ID_Continue}]*$/u, Tm = /^[$_\p{ID_Start}][-$_\u{200C}\u{200D}\p{ID_Continue}]*$/u, Em = {};
function Dm(e, t) {
	return ((t || Em).jsx ? Tm : wm).test(e);
}
//#endregion
//#region node_modules/hast-util-whitespace/lib/index.js
var Om = /[ \t\n\f\r]/g;
function km(e) {
	return typeof e == "object" ? e.type === "text" && Am(e.value) : Am(e);
}
function Am(e) {
	return e.replace(Om, "") === "";
}
//#endregion
//#region node_modules/property-information/lib/util/schema.js
var jm = class {
	constructor(e, t, n) {
		this.normal = t, this.property = e, n && (this.space = n);
	}
};
jm.prototype.normal = {}, jm.prototype.property = {}, jm.prototype.space = void 0;
//#endregion
//#region node_modules/property-information/lib/util/merge.js
function Mm(e, t) {
	let n = {}, r = {};
	for (let t of e) Object.assign(n, t.property), Object.assign(r, t.normal);
	return new jm(n, r, t);
}
//#endregion
//#region node_modules/property-information/lib/normalize.js
function Nm(e) {
	return e.toLowerCase();
}
//#endregion
//#region node_modules/property-information/lib/util/info.js
var Pm = class {
	constructor(e, t) {
		this.attribute = t, this.property = e;
	}
};
Pm.prototype.attribute = "", Pm.prototype.booleanish = !1, Pm.prototype.boolean = !1, Pm.prototype.commaOrSpaceSeparated = !1, Pm.prototype.commaSeparated = !1, Pm.prototype.defined = !1, Pm.prototype.mustUseProperty = !1, Pm.prototype.number = !1, Pm.prototype.overloadedBoolean = !1, Pm.prototype.property = "", Pm.prototype.spaceSeparated = !1, Pm.prototype.space = void 0;
//#endregion
//#region node_modules/property-information/lib/util/types.js
var Fm = /* @__PURE__ */ s({
	boolean: () => Y,
	booleanish: () => Lm,
	commaOrSpaceSeparated: () => Vm,
	commaSeparated: () => Bm,
	number: () => X,
	overloadedBoolean: () => Rm,
	spaceSeparated: () => zm
}), Im = 0, Y = Hm(), Lm = Hm(), Rm = Hm(), X = Hm(), zm = Hm(), Bm = Hm(), Vm = Hm();
function Hm() {
	return 2 ** ++Im;
}
//#endregion
//#region node_modules/property-information/lib/util/defined-info.js
var Um = Object.keys(Fm), Wm = class extends Pm {
	constructor(e, t, n, r) {
		let i = -1;
		if (super(e, t), Gm(this, "space", r), typeof n == "number") for (; ++i < Um.length;) {
			let e = Um[i];
			Gm(this, Um[i], (n & Fm[e]) === Fm[e]);
		}
	}
};
Wm.prototype.defined = !0;
function Gm(e, t, n) {
	n && (e[t] = n);
}
//#endregion
//#region node_modules/property-information/lib/util/create.js
function Km(e) {
	let t = {}, n = {};
	for (let [r, i] of Object.entries(e.properties)) {
		let a = new Wm(r, e.transform(e.attributes || {}, r), i, e.space);
		e.mustUseProperty && e.mustUseProperty.includes(r) && (a.mustUseProperty = !0), t[r] = a, n[Nm(r)] = r, n[Nm(a.attribute)] = r;
	}
	return new jm(t, n, e.space);
}
//#endregion
//#region node_modules/property-information/lib/aria.js
var qm = Km({
	properties: {
		ariaActiveDescendant: null,
		ariaAtomic: Lm,
		ariaAutoComplete: null,
		ariaBusy: Lm,
		ariaChecked: Lm,
		ariaColCount: X,
		ariaColIndex: X,
		ariaColSpan: X,
		ariaControls: zm,
		ariaCurrent: null,
		ariaDescribedBy: zm,
		ariaDetails: null,
		ariaDisabled: Lm,
		ariaDropEffect: zm,
		ariaErrorMessage: null,
		ariaExpanded: Lm,
		ariaFlowTo: zm,
		ariaGrabbed: Lm,
		ariaHasPopup: null,
		ariaHidden: Lm,
		ariaInvalid: null,
		ariaKeyShortcuts: null,
		ariaLabel: null,
		ariaLabelledBy: zm,
		ariaLevel: X,
		ariaLive: null,
		ariaModal: Lm,
		ariaMultiLine: Lm,
		ariaMultiSelectable: Lm,
		ariaOrientation: null,
		ariaOwns: zm,
		ariaPlaceholder: null,
		ariaPosInSet: X,
		ariaPressed: Lm,
		ariaReadOnly: Lm,
		ariaRelevant: null,
		ariaRequired: Lm,
		ariaRoleDescription: zm,
		ariaRowCount: X,
		ariaRowIndex: X,
		ariaRowSpan: X,
		ariaSelected: Lm,
		ariaSetSize: X,
		ariaSort: null,
		ariaValueMax: X,
		ariaValueMin: X,
		ariaValueNow: X,
		ariaValueText: null,
		role: null
	},
	transform(e, t) {
		return t === "role" ? t : "aria-" + t.slice(4).toLowerCase();
	}
});
//#endregion
//#region node_modules/property-information/lib/util/case-sensitive-transform.js
function Jm(e, t) {
	return t in e ? e[t] : t;
}
//#endregion
//#region node_modules/property-information/lib/util/case-insensitive-transform.js
function Ym(e, t) {
	return Jm(e, t.toLowerCase());
}
//#endregion
//#region node_modules/property-information/lib/html.js
var Xm = Km({
	attributes: {
		acceptcharset: "accept-charset",
		classname: "class",
		htmlfor: "for",
		httpequiv: "http-equiv"
	},
	mustUseProperty: [
		"checked",
		"multiple",
		"muted",
		"selected"
	],
	properties: {
		abbr: null,
		accept: Bm,
		acceptCharset: zm,
		accessKey: zm,
		action: null,
		allow: null,
		allowFullScreen: Y,
		allowPaymentRequest: Y,
		allowUserMedia: Y,
		alpha: Y,
		alt: null,
		as: null,
		async: Y,
		autoCapitalize: null,
		autoComplete: zm,
		autoFocus: Y,
		autoPlay: Y,
		blocking: zm,
		capture: null,
		charSet: null,
		checked: Y,
		cite: null,
		className: zm,
		closedBy: null,
		colorSpace: null,
		cols: X,
		colSpan: X,
		command: null,
		commandFor: null,
		content: null,
		contentEditable: Lm,
		controls: Y,
		controlsList: zm,
		coords: X | Bm,
		crossOrigin: null,
		data: null,
		dateTime: null,
		decoding: null,
		default: Y,
		defer: Y,
		dir: null,
		dirName: null,
		disabled: Y,
		download: Rm,
		draggable: Lm,
		encType: null,
		enterKeyHint: null,
		fetchPriority: null,
		form: null,
		formAction: null,
		formEncType: null,
		formMethod: null,
		formNoValidate: Y,
		formTarget: null,
		headers: zm,
		height: X,
		hidden: Rm,
		high: X,
		href: null,
		hrefLang: null,
		htmlFor: zm,
		httpEquiv: zm,
		id: null,
		imageSizes: null,
		imageSrcSet: null,
		inert: Y,
		inputMode: null,
		integrity: null,
		is: null,
		isMap: Y,
		itemId: null,
		itemProp: zm,
		itemRef: zm,
		itemScope: Y,
		itemType: zm,
		kind: null,
		label: null,
		lang: null,
		language: null,
		list: null,
		loading: null,
		loop: Y,
		low: X,
		manifest: null,
		max: null,
		maxLength: X,
		media: null,
		method: null,
		min: null,
		minLength: X,
		multiple: Y,
		muted: Y,
		name: null,
		nonce: null,
		noModule: Y,
		noValidate: Y,
		onAbort: null,
		onAfterPrint: null,
		onAuxClick: null,
		onBeforeMatch: null,
		onBeforePrint: null,
		onBeforeToggle: null,
		onBeforeUnload: null,
		onBlur: null,
		onCancel: null,
		onCanPlay: null,
		onCanPlayThrough: null,
		onChange: null,
		onClick: null,
		onClose: null,
		onContextLost: null,
		onContextMenu: null,
		onContextRestored: null,
		onCopy: null,
		onCueChange: null,
		onCut: null,
		onDblClick: null,
		onDrag: null,
		onDragEnd: null,
		onDragEnter: null,
		onDragExit: null,
		onDragLeave: null,
		onDragOver: null,
		onDragStart: null,
		onDrop: null,
		onDurationChange: null,
		onEmptied: null,
		onEnded: null,
		onError: null,
		onFocus: null,
		onFormData: null,
		onHashChange: null,
		onInput: null,
		onInvalid: null,
		onKeyDown: null,
		onKeyPress: null,
		onKeyUp: null,
		onLanguageChange: null,
		onLoad: null,
		onLoadedData: null,
		onLoadedMetadata: null,
		onLoadEnd: null,
		onLoadStart: null,
		onMessage: null,
		onMessageError: null,
		onMouseDown: null,
		onMouseEnter: null,
		onMouseLeave: null,
		onMouseMove: null,
		onMouseOut: null,
		onMouseOver: null,
		onMouseUp: null,
		onOffline: null,
		onOnline: null,
		onPageHide: null,
		onPageShow: null,
		onPaste: null,
		onPause: null,
		onPlay: null,
		onPlaying: null,
		onPopState: null,
		onProgress: null,
		onRateChange: null,
		onRejectionHandled: null,
		onReset: null,
		onResize: null,
		onScroll: null,
		onScrollEnd: null,
		onSecurityPolicyViolation: null,
		onSeeked: null,
		onSeeking: null,
		onSelect: null,
		onSlotChange: null,
		onStalled: null,
		onStorage: null,
		onSubmit: null,
		onSuspend: null,
		onTimeUpdate: null,
		onToggle: null,
		onUnhandledRejection: null,
		onUnload: null,
		onVolumeChange: null,
		onWaiting: null,
		onWheel: null,
		open: Y,
		optimum: X,
		pattern: null,
		ping: zm,
		placeholder: null,
		playsInline: Y,
		popover: null,
		popoverTarget: null,
		popoverTargetAction: null,
		poster: null,
		preload: null,
		readOnly: Y,
		referrerPolicy: null,
		rel: zm,
		required: Y,
		reversed: Y,
		rows: X,
		rowSpan: X,
		sandbox: zm,
		scope: null,
		scoped: Y,
		seamless: Y,
		selected: Y,
		shadowRootClonable: Y,
		shadowRootCustomElementRegistry: Y,
		shadowRootDelegatesFocus: Y,
		shadowRootMode: null,
		shadowRootSerializable: Y,
		shape: null,
		size: X,
		sizes: null,
		slot: null,
		span: X,
		spellCheck: Lm,
		src: null,
		srcDoc: null,
		srcLang: null,
		srcSet: null,
		start: X,
		step: null,
		style: null,
		tabIndex: X,
		target: null,
		title: null,
		translate: null,
		type: null,
		typeMustMatch: Y,
		useMap: null,
		value: Lm,
		width: X,
		wrap: null,
		writingSuggestions: null,
		align: null,
		aLink: null,
		archive: zm,
		axis: null,
		background: null,
		bgColor: null,
		border: X,
		borderColor: null,
		bottomMargin: X,
		cellPadding: null,
		cellSpacing: null,
		char: null,
		charOff: null,
		classId: null,
		clear: null,
		code: null,
		codeBase: null,
		codeType: null,
		color: null,
		compact: Y,
		declare: Y,
		event: null,
		face: null,
		frame: null,
		frameBorder: null,
		hSpace: X,
		leftMargin: X,
		link: null,
		longDesc: null,
		lowSrc: null,
		marginHeight: X,
		marginWidth: X,
		noResize: Y,
		noHref: Y,
		noShade: Y,
		noWrap: Y,
		object: null,
		profile: null,
		prompt: null,
		rev: null,
		rightMargin: X,
		rules: null,
		scheme: null,
		scrolling: Lm,
		standby: null,
		summary: null,
		text: null,
		topMargin: X,
		valueType: null,
		version: null,
		vAlign: null,
		vLink: null,
		vSpace: X,
		allowTransparency: null,
		autoCorrect: null,
		autoSave: null,
		credentialless: Y,
		disablePictureInPicture: Y,
		disableRemotePlayback: Y,
		exportParts: Bm,
		part: zm,
		prefix: null,
		property: null,
		results: X,
		security: null,
		unselectable: null
	},
	space: "html",
	transform: Ym
}), Zm = Km({
	attributes: {
		accentHeight: "accent-height",
		alignmentBaseline: "alignment-baseline",
		arabicForm: "arabic-form",
		baselineShift: "baseline-shift",
		capHeight: "cap-height",
		className: "class",
		clipPath: "clip-path",
		clipRule: "clip-rule",
		colorInterpolation: "color-interpolation",
		colorInterpolationFilters: "color-interpolation-filters",
		colorProfile: "color-profile",
		colorRendering: "color-rendering",
		crossOrigin: "crossorigin",
		dataType: "datatype",
		dominantBaseline: "dominant-baseline",
		enableBackground: "enable-background",
		fillOpacity: "fill-opacity",
		fillRule: "fill-rule",
		floodColor: "flood-color",
		floodOpacity: "flood-opacity",
		fontFamily: "font-family",
		fontSize: "font-size",
		fontSizeAdjust: "font-size-adjust",
		fontStretch: "font-stretch",
		fontStyle: "font-style",
		fontVariant: "font-variant",
		fontWeight: "font-weight",
		glyphName: "glyph-name",
		glyphOrientationHorizontal: "glyph-orientation-horizontal",
		glyphOrientationVertical: "glyph-orientation-vertical",
		hrefLang: "hreflang",
		horizAdvX: "horiz-adv-x",
		horizOriginX: "horiz-origin-x",
		horizOriginY: "horiz-origin-y",
		imageRendering: "image-rendering",
		letterSpacing: "letter-spacing",
		lightingColor: "lighting-color",
		markerEnd: "marker-end",
		markerMid: "marker-mid",
		markerStart: "marker-start",
		maskType: "mask-type",
		navDown: "nav-down",
		navDownLeft: "nav-down-left",
		navDownRight: "nav-down-right",
		navLeft: "nav-left",
		navNext: "nav-next",
		navPrev: "nav-prev",
		navRight: "nav-right",
		navUp: "nav-up",
		navUpLeft: "nav-up-left",
		navUpRight: "nav-up-right",
		onAbort: "onabort",
		onActivate: "onactivate",
		onAfterPrint: "onafterprint",
		onBeforePrint: "onbeforeprint",
		onBegin: "onbegin",
		onCancel: "oncancel",
		onCanPlay: "oncanplay",
		onCanPlayThrough: "oncanplaythrough",
		onChange: "onchange",
		onClick: "onclick",
		onClose: "onclose",
		onCopy: "oncopy",
		onCueChange: "oncuechange",
		onCut: "oncut",
		onDblClick: "ondblclick",
		onDrag: "ondrag",
		onDragEnd: "ondragend",
		onDragEnter: "ondragenter",
		onDragExit: "ondragexit",
		onDragLeave: "ondragleave",
		onDragOver: "ondragover",
		onDragStart: "ondragstart",
		onDrop: "ondrop",
		onDurationChange: "ondurationchange",
		onEmptied: "onemptied",
		onEnd: "onend",
		onEnded: "onended",
		onError: "onerror",
		onFocus: "onfocus",
		onFocusIn: "onfocusin",
		onFocusOut: "onfocusout",
		onHashChange: "onhashchange",
		onInput: "oninput",
		onInvalid: "oninvalid",
		onKeyDown: "onkeydown",
		onKeyPress: "onkeypress",
		onKeyUp: "onkeyup",
		onLoad: "onload",
		onLoadedData: "onloadeddata",
		onLoadedMetadata: "onloadedmetadata",
		onLoadStart: "onloadstart",
		onMessage: "onmessage",
		onMouseDown: "onmousedown",
		onMouseEnter: "onmouseenter",
		onMouseLeave: "onmouseleave",
		onMouseMove: "onmousemove",
		onMouseOut: "onmouseout",
		onMouseOver: "onmouseover",
		onMouseUp: "onmouseup",
		onMouseWheel: "onmousewheel",
		onOffline: "onoffline",
		onOnline: "ononline",
		onPageHide: "onpagehide",
		onPageShow: "onpageshow",
		onPaste: "onpaste",
		onPause: "onpause",
		onPlay: "onplay",
		onPlaying: "onplaying",
		onPopState: "onpopstate",
		onProgress: "onprogress",
		onRateChange: "onratechange",
		onRepeat: "onrepeat",
		onReset: "onreset",
		onResize: "onresize",
		onScroll: "onscroll",
		onSeeked: "onseeked",
		onSeeking: "onseeking",
		onSelect: "onselect",
		onShow: "onshow",
		onStalled: "onstalled",
		onStorage: "onstorage",
		onSubmit: "onsubmit",
		onSuspend: "onsuspend",
		onTimeUpdate: "ontimeupdate",
		onToggle: "ontoggle",
		onUnload: "onunload",
		onVolumeChange: "onvolumechange",
		onWaiting: "onwaiting",
		onZoom: "onzoom",
		overlinePosition: "overline-position",
		overlineThickness: "overline-thickness",
		paintOrder: "paint-order",
		panose1: "panose-1",
		pointerEvents: "pointer-events",
		referrerPolicy: "referrerpolicy",
		renderingIntent: "rendering-intent",
		shapeRendering: "shape-rendering",
		stopColor: "stop-color",
		stopOpacity: "stop-opacity",
		strikethroughPosition: "strikethrough-position",
		strikethroughThickness: "strikethrough-thickness",
		strokeDashArray: "stroke-dasharray",
		strokeDashOffset: "stroke-dashoffset",
		strokeLineCap: "stroke-linecap",
		strokeLineJoin: "stroke-linejoin",
		strokeMiterLimit: "stroke-miterlimit",
		strokeOpacity: "stroke-opacity",
		strokeWidth: "stroke-width",
		tabIndex: "tabindex",
		textAnchor: "text-anchor",
		textDecoration: "text-decoration",
		textRendering: "text-rendering",
		transformOrigin: "transform-origin",
		typeOf: "typeof",
		underlinePosition: "underline-position",
		underlineThickness: "underline-thickness",
		unicodeBidi: "unicode-bidi",
		unicodeRange: "unicode-range",
		unitsPerEm: "units-per-em",
		vAlphabetic: "v-alphabetic",
		vHanging: "v-hanging",
		vIdeographic: "v-ideographic",
		vMathematical: "v-mathematical",
		vectorEffect: "vector-effect",
		vertAdvY: "vert-adv-y",
		vertOriginX: "vert-origin-x",
		vertOriginY: "vert-origin-y",
		wordSpacing: "word-spacing",
		writingMode: "writing-mode",
		xHeight: "x-height",
		playbackOrder: "playbackorder",
		timelineBegin: "timelinebegin"
	},
	properties: {
		about: Vm,
		accentHeight: X,
		accumulate: null,
		additive: null,
		alignmentBaseline: null,
		alphabetic: X,
		amplitude: X,
		arabicForm: null,
		ascent: X,
		attributeName: null,
		attributeType: null,
		azimuth: X,
		bandwidth: null,
		baselineShift: null,
		baseFrequency: null,
		baseProfile: null,
		bbox: null,
		begin: null,
		bias: X,
		by: null,
		calcMode: null,
		capHeight: X,
		className: zm,
		clip: null,
		clipPath: null,
		clipPathUnits: null,
		clipRule: null,
		color: null,
		colorInterpolation: null,
		colorInterpolationFilters: null,
		colorProfile: null,
		colorRendering: null,
		content: null,
		contentScriptType: null,
		contentStyleType: null,
		crossOrigin: null,
		cursor: null,
		cx: null,
		cy: null,
		d: null,
		dataType: null,
		defaultAction: null,
		descent: X,
		diffuseConstant: X,
		direction: null,
		display: null,
		dur: null,
		divisor: X,
		dominantBaseline: null,
		download: Y,
		dx: null,
		dy: null,
		edgeMode: null,
		editable: null,
		elevation: X,
		enableBackground: null,
		end: null,
		event: null,
		exponent: X,
		externalResourcesRequired: null,
		fill: null,
		fillOpacity: X,
		fillRule: null,
		filter: null,
		filterRes: null,
		filterUnits: null,
		floodColor: null,
		floodOpacity: null,
		focusable: null,
		focusHighlight: null,
		fontFamily: null,
		fontSize: null,
		fontSizeAdjust: null,
		fontStretch: null,
		fontStyle: null,
		fontVariant: null,
		fontWeight: null,
		format: null,
		fr: null,
		from: null,
		fx: null,
		fy: null,
		g1: Bm,
		g2: Bm,
		glyphName: Bm,
		glyphOrientationHorizontal: null,
		glyphOrientationVertical: null,
		glyphRef: null,
		gradientTransform: null,
		gradientUnits: null,
		handler: null,
		hanging: X,
		hatchContentUnits: null,
		hatchUnits: null,
		height: null,
		href: null,
		hrefLang: null,
		horizAdvX: X,
		horizOriginX: X,
		horizOriginY: X,
		id: null,
		ideographic: X,
		imageRendering: null,
		initialVisibility: null,
		in: null,
		in2: null,
		intercept: X,
		k: X,
		k1: X,
		k2: X,
		k3: X,
		k4: X,
		kernelMatrix: Vm,
		kernelUnitLength: null,
		keyPoints: null,
		keySplines: null,
		keyTimes: null,
		kerning: null,
		lang: null,
		lengthAdjust: null,
		letterSpacing: null,
		lightingColor: null,
		limitingConeAngle: X,
		local: null,
		markerEnd: null,
		markerMid: null,
		markerStart: null,
		markerHeight: null,
		markerUnits: null,
		markerWidth: null,
		mask: null,
		maskContentUnits: null,
		maskType: null,
		maskUnits: null,
		mathematical: null,
		max: null,
		media: null,
		mediaCharacterEncoding: null,
		mediaContentEncodings: null,
		mediaSize: X,
		mediaTime: null,
		method: null,
		min: null,
		mode: null,
		name: null,
		navDown: null,
		navDownLeft: null,
		navDownRight: null,
		navLeft: null,
		navNext: null,
		navPrev: null,
		navRight: null,
		navUp: null,
		navUpLeft: null,
		navUpRight: null,
		numOctaves: null,
		observer: null,
		offset: null,
		onAbort: null,
		onActivate: null,
		onAfterPrint: null,
		onBeforePrint: null,
		onBegin: null,
		onCancel: null,
		onCanPlay: null,
		onCanPlayThrough: null,
		onChange: null,
		onClick: null,
		onClose: null,
		onCopy: null,
		onCueChange: null,
		onCut: null,
		onDblClick: null,
		onDrag: null,
		onDragEnd: null,
		onDragEnter: null,
		onDragExit: null,
		onDragLeave: null,
		onDragOver: null,
		onDragStart: null,
		onDrop: null,
		onDurationChange: null,
		onEmptied: null,
		onEnd: null,
		onEnded: null,
		onError: null,
		onFocus: null,
		onFocusIn: null,
		onFocusOut: null,
		onHashChange: null,
		onInput: null,
		onInvalid: null,
		onKeyDown: null,
		onKeyPress: null,
		onKeyUp: null,
		onLoad: null,
		onLoadedData: null,
		onLoadedMetadata: null,
		onLoadStart: null,
		onMessage: null,
		onMouseDown: null,
		onMouseEnter: null,
		onMouseLeave: null,
		onMouseMove: null,
		onMouseOut: null,
		onMouseOver: null,
		onMouseUp: null,
		onMouseWheel: null,
		onOffline: null,
		onOnline: null,
		onPageHide: null,
		onPageShow: null,
		onPaste: null,
		onPause: null,
		onPlay: null,
		onPlaying: null,
		onPopState: null,
		onProgress: null,
		onRateChange: null,
		onRepeat: null,
		onReset: null,
		onResize: null,
		onScroll: null,
		onSeeked: null,
		onSeeking: null,
		onSelect: null,
		onShow: null,
		onStalled: null,
		onStorage: null,
		onSubmit: null,
		onSuspend: null,
		onTimeUpdate: null,
		onToggle: null,
		onUnload: null,
		onVolumeChange: null,
		onWaiting: null,
		onZoom: null,
		opacity: null,
		operator: null,
		order: null,
		orient: null,
		orientation: null,
		origin: null,
		overflow: null,
		overlay: null,
		overlinePosition: X,
		overlineThickness: X,
		paintOrder: null,
		panose1: null,
		path: null,
		pathLength: X,
		patternContentUnits: null,
		patternTransform: null,
		patternUnits: null,
		phase: null,
		ping: zm,
		pitch: null,
		playbackOrder: null,
		pointerEvents: null,
		points: null,
		pointsAtX: X,
		pointsAtY: X,
		pointsAtZ: X,
		preserveAlpha: null,
		preserveAspectRatio: null,
		primitiveUnits: null,
		propagate: null,
		property: Vm,
		r: null,
		radius: null,
		referrerPolicy: null,
		refX: null,
		refY: null,
		rel: Vm,
		rev: Vm,
		renderingIntent: null,
		repeatCount: null,
		repeatDur: null,
		requiredExtensions: Vm,
		requiredFeatures: Vm,
		requiredFonts: Vm,
		requiredFormats: Vm,
		resource: null,
		restart: null,
		result: null,
		rotate: null,
		rx: null,
		ry: null,
		scale: null,
		seed: null,
		shapeRendering: null,
		side: null,
		slope: null,
		snapshotTime: null,
		specularConstant: X,
		specularExponent: X,
		spreadMethod: null,
		spacing: null,
		startOffset: null,
		stdDeviation: null,
		stemh: null,
		stemv: null,
		stitchTiles: null,
		stopColor: null,
		stopOpacity: null,
		strikethroughPosition: X,
		strikethroughThickness: X,
		string: null,
		stroke: null,
		strokeDashArray: Vm,
		strokeDashOffset: null,
		strokeLineCap: null,
		strokeLineJoin: null,
		strokeMiterLimit: X,
		strokeOpacity: X,
		strokeWidth: null,
		style: null,
		surfaceScale: X,
		syncBehavior: null,
		syncBehaviorDefault: null,
		syncMaster: null,
		syncTolerance: null,
		syncToleranceDefault: null,
		systemLanguage: Vm,
		tabIndex: X,
		tableValues: null,
		target: null,
		targetX: X,
		targetY: X,
		textAnchor: null,
		textDecoration: null,
		textRendering: null,
		textLength: null,
		timelineBegin: null,
		title: null,
		transformBehavior: null,
		type: null,
		typeOf: Vm,
		to: null,
		transform: null,
		transformOrigin: null,
		u1: null,
		u2: null,
		underlinePosition: X,
		underlineThickness: X,
		unicode: null,
		unicodeBidi: null,
		unicodeRange: null,
		unitsPerEm: X,
		values: null,
		vAlphabetic: X,
		vMathematical: X,
		vectorEffect: null,
		vHanging: X,
		vIdeographic: X,
		version: null,
		vertAdvY: X,
		vertOriginX: X,
		vertOriginY: X,
		viewBox: null,
		viewTarget: null,
		visibility: null,
		width: null,
		widths: null,
		wordSpacing: null,
		writingMode: null,
		x: null,
		x1: null,
		x2: null,
		xChannelSelector: null,
		xHeight: X,
		y: null,
		y1: null,
		y2: null,
		yChannelSelector: null,
		z: null,
		zoomAndPan: null
	},
	space: "svg",
	transform: Jm
}), Qm = Km({
	properties: {
		xLinkActuate: null,
		xLinkArcRole: null,
		xLinkHref: null,
		xLinkRole: null,
		xLinkShow: null,
		xLinkTitle: null,
		xLinkType: null
	},
	space: "xlink",
	transform(e, t) {
		return "xlink:" + t.slice(5).toLowerCase();
	}
}), $m = Km({
	attributes: { xmlnsxlink: "xmlns:xlink" },
	properties: {
		xmlnsXLink: null,
		xmlns: null
	},
	space: "xmlns",
	transform: Ym
}), eh = Km({
	properties: {
		xmlBase: null,
		xmlLang: null,
		xmlSpace: null
	},
	space: "xml",
	transform(e, t) {
		return "xml:" + t.slice(3).toLowerCase();
	}
}), th = {
	classId: "classID",
	dataType: "datatype",
	itemId: "itemID",
	strokeDashArray: "strokeDasharray",
	strokeDashOffset: "strokeDashoffset",
	strokeLineCap: "strokeLinecap",
	strokeLineJoin: "strokeLinejoin",
	strokeMiterLimit: "strokeMiterlimit",
	typeOf: "typeof",
	xLinkActuate: "xlinkActuate",
	xLinkArcRole: "xlinkArcrole",
	xLinkHref: "xlinkHref",
	xLinkRole: "xlinkRole",
	xLinkShow: "xlinkShow",
	xLinkTitle: "xlinkTitle",
	xLinkType: "xlinkType",
	xmlnsXLink: "xmlnsXlink"
}, nh = /[A-Z]/g, rh = /-[a-z]/g, ih = /^data[-\w.:]+$/i;
function ah(e, t) {
	let n = Nm(t), r = t, i = Pm;
	if (n in e.normal) return e.property[e.normal[n]];
	if (n.length > 4 && n.slice(0, 4) === "data" && ih.test(t)) {
		if (t.charAt(4) === "-") {
			let e = t.slice(5).replace(rh, sh);
			r = "data" + e.charAt(0).toUpperCase() + e.slice(1);
		} else {
			let e = t.slice(4);
			if (!rh.test(e)) {
				let n = e.replace(nh, oh);
				n.charAt(0) !== "-" && (n = "-" + n), t = "data" + n;
			}
		}
		i = Wm;
	}
	return new i(r, t);
}
function oh(e) {
	return "-" + e.toLowerCase();
}
function sh(e) {
	return e.charAt(1).toUpperCase();
}
//#endregion
//#region node_modules/property-information/index.js
var ch = Mm([
	qm,
	Xm,
	Qm,
	$m,
	eh
], "html"), lh = Mm([
	qm,
	Zm,
	Qm,
	$m,
	eh
], "svg");
//#endregion
//#region node_modules/space-separated-tokens/index.js
function uh(e) {
	return e.join(" ").trim();
}
//#endregion
//#region node_modules/inline-style-parser/cjs/index.js
var dh = /* @__PURE__ */ o(((e, t) => {
	var n = /\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, r = /\n/g, i = /^\s*/, a = /^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*/, o = /^:\s*/, s = /^((?:'(?:\\'|.)*?'|"(?:\\"|.)*?"|\([^)]*?\)|[^};])+)/, c = /^[;\s]*/, l = /^\s+|\s+$/g;
	function u(e, t) {
		if (typeof e != "string") throw TypeError("First argument must be a string");
		if (!e) return [];
		t ||= {};
		var l = 1, u = 1;
		function f(e) {
			var t = e.match(r);
			t && (l += t.length);
			var n = e.lastIndexOf("\n");
			u = ~n ? e.length - n : u + e.length;
		}
		function p() {
			var e = {
				line: l,
				column: u
			};
			return function(t) {
				return t.position = new m(e), _(), t;
			};
		}
		function m(e) {
			this.start = e, this.end = {
				line: l,
				column: u
			}, this.source = t.source;
		}
		m.prototype.content = e;
		function h(n) {
			var r = /* @__PURE__ */ Error(t.source + ":" + l + ":" + u + ": " + n);
			if (r.reason = n, r.filename = t.source, r.line = l, r.column = u, r.source = e, !t.silent) throw r;
		}
		function g(t) {
			var n = t.exec(e);
			if (n) {
				var r = n[0];
				return f(r), e = e.slice(r.length), n;
			}
		}
		function _() {
			g(i);
		}
		function v(e) {
			var t;
			for (e ||= []; t = y();) t !== !1 && e.push(t);
			return e;
		}
		function y() {
			var t = p();
			if (e.charAt(0) == "/" && e.charAt(1) == "*") {
				for (var n = 2; e.charAt(n) != "" && (e.charAt(n) != "*" || e.charAt(n + 1) != "/");) ++n;
				if (n += 2, e.charAt(n - 1) === "") return h("End of comment missing");
				var r = e.slice(2, n - 2);
				return u += 2, f(r), e = e.slice(n), u += 2, t({
					type: "comment",
					comment: r
				});
			}
		}
		function b() {
			var e = p(), t = g(a);
			if (t) {
				if (y(), !g(o)) return h("property missing ':'");
				var r = g(s), i = e({
					type: "declaration",
					property: d(t[0].replace(n, "")),
					value: r ? d(r[0].replace(n, "")) : ""
				});
				return g(c), i;
			}
		}
		function x() {
			var e = [];
			v(e);
			for (var t; t = b();) t !== !1 && (e.push(t), v(e));
			return e;
		}
		return _(), x();
	}
	function d(e) {
		return e ? e.replace(l, "") : "";
	}
	t.exports = u;
})), fh = /* @__PURE__ */ o(((e) => {
	var t = e && e.__importDefault || function(e) {
		return e && e.__esModule ? e : { default: e };
	};
	Object.defineProperty(e, "__esModule", { value: !0 }), e.default = r;
	var n = t(dh());
	function r(e, t) {
		let r = null;
		if (!e || typeof e != "string") return r;
		let i = (0, n.default)(e), a = typeof t == "function";
		return i.forEach((e) => {
			if (e.type !== "declaration") return;
			let { property: n, value: i } = e;
			a ? t(n, i, e) : i && (r ||= {}, r[n] = i);
		}), r;
	}
})), ph = /* @__PURE__ */ o(((e) => {
	Object.defineProperty(e, "__esModule", { value: !0 }), e.camelCase = void 0;
	var t = /^--[a-zA-Z0-9_-]+$/, n = /-([a-z])/g, r = /^[^-]+$/, i = /^-(webkit|moz|ms|o|khtml)-/, a = /^-(ms)-/, o = function(e) {
		return !e || r.test(e) || t.test(e);
	}, s = function(e, t) {
		return t.toUpperCase();
	}, c = function(e, t) {
		return `${t}-`;
	};
	e.camelCase = function(e, t) {
		return t === void 0 && (t = {}), o(e) ? e : (e = e.toLowerCase(), e = t.reactCompat ? e.replace(a, c) : e.replace(i, c), e.replace(n, s));
	};
})), mh = /* @__PURE__ */ o(((e, t) => {
	var n = (e && e.__importDefault || function(e) {
		return e && e.__esModule ? e : { default: e };
	})(fh()), r = ph();
	function i(e, t) {
		var i = {};
		return !e || typeof e != "string" || (0, n.default)(e, function(e, n) {
			e && n && (i[(0, r.camelCase)(e, t)] = n);
		}), i;
	}
	i.default = i, t.exports = i;
})), hh = _h("end"), gh = _h("start");
function _h(e) {
	return t;
	function t(t) {
		let n = t && t.position && t.position[e] || {};
		if (typeof n.line == "number" && n.line > 0 && typeof n.column == "number" && n.column > 0) return {
			line: n.line,
			column: n.column,
			offset: typeof n.offset == "number" && n.offset > -1 ? n.offset : void 0
		};
	}
}
function vh(e) {
	let t = gh(e), n = hh(e);
	if (t && n) return {
		start: t,
		end: n
	};
}
//#endregion
//#region node_modules/unist-util-stringify-position/lib/index.js
function yh(e) {
	return !e || typeof e != "object" ? "" : "position" in e || "type" in e ? xh(e.position) : "start" in e || "end" in e ? xh(e) : "line" in e || "column" in e ? bh(e) : "";
}
function bh(e) {
	return Sh(e && e.line) + ":" + Sh(e && e.column);
}
function xh(e) {
	return bh(e && e.start) + "-" + bh(e && e.end);
}
function Sh(e) {
	return e && typeof e == "number" ? e : 1;
}
//#endregion
//#region node_modules/vfile-message/lib/index.js
var Ch = class extends Error {
	constructor(e, t, n) {
		super(), typeof t == "string" && (n = t, t = void 0);
		let r = "", i = {}, a = !1;
		if (t && (i = "line" in t && "column" in t || "start" in t && "end" in t ? { place: t } : "type" in t ? {
			ancestors: [t],
			place: t.position
		} : { ...t }), typeof e == "string" ? r = e : !i.cause && e && (a = !0, r = e.message, i.cause = e), !i.ruleId && !i.source && typeof n == "string") {
			let e = n.indexOf(":");
			e === -1 ? i.ruleId = n : (i.source = n.slice(0, e), i.ruleId = n.slice(e + 1));
		}
		if (!i.place && i.ancestors && i.ancestors) {
			let e = i.ancestors[i.ancestors.length - 1];
			e && (i.place = e.position);
		}
		let o = i.place && "start" in i.place ? i.place.start : i.place;
		this.ancestors = i.ancestors || void 0, this.cause = i.cause || void 0, this.column = o ? o.column : void 0, this.fatal = void 0, this.file = "", this.message = r, this.line = o ? o.line : void 0, this.name = yh(i.place) || "1:1", this.place = i.place || void 0, this.reason = this.message, this.ruleId = i.ruleId || void 0, this.source = i.source || void 0, this.stack = a && i.cause && typeof i.cause.stack == "string" ? i.cause.stack : "", this.actual = void 0, this.expected = void 0, this.note = void 0, this.url = void 0;
	}
};
Ch.prototype.file = "", Ch.prototype.name = "", Ch.prototype.reason = "", Ch.prototype.message = "", Ch.prototype.stack = "", Ch.prototype.column = void 0, Ch.prototype.line = void 0, Ch.prototype.ancestors = void 0, Ch.prototype.cause = void 0, Ch.prototype.fatal = void 0, Ch.prototype.place = void 0, Ch.prototype.ruleId = void 0, Ch.prototype.source = void 0;
//#endregion
//#region node_modules/hast-util-to-jsx-runtime/lib/index.js
var wh = /* @__PURE__ */ l(mh(), 1), Th = {}.hasOwnProperty, Eh = /* @__PURE__ */ new Map(), Dh = /[A-Z]/g, Oh = /* @__PURE__ */ new Set([
	"table",
	"tbody",
	"thead",
	"tfoot",
	"tr"
]), kh = /* @__PURE__ */ new Set(["td", "th"]), Ah = "https://github.com/syntax-tree/hast-util-to-jsx-runtime";
function jh(e, t) {
	if (!t || t.Fragment === void 0) throw TypeError("Expected `Fragment` in options");
	let n = t.filePath || void 0, r;
	if (t.development) {
		if (typeof t.jsxDEV != "function") throw TypeError("Expected `jsxDEV` in options when `development: true`");
		r = Hh(n, t.jsxDEV);
	} else {
		if (typeof t.jsx != "function") throw TypeError("Expected `jsx` in production options");
		if (typeof t.jsxs != "function") throw TypeError("Expected `jsxs` in production options");
		r = Vh(n, t.jsx, t.jsxs);
	}
	let i = {
		Fragment: t.Fragment,
		ancestors: [],
		components: t.components || {},
		create: r,
		elementAttributeNameCase: t.elementAttributeNameCase || "react",
		evaluater: t.createEvaluater ? t.createEvaluater() : void 0,
		filePath: n,
		ignoreInvalidStyle: t.ignoreInvalidStyle || !1,
		passKeys: t.passKeys !== !1,
		passNode: t.passNode || !1,
		schema: t.space === "svg" ? lh : ch,
		stylePropertyNameCase: t.stylePropertyNameCase || "dom",
		tableCellAlignToStyle: t.tableCellAlignToStyle !== !1
	}, a = Mh(i, e, void 0);
	return a && typeof a != "string" ? a : i.create(e, i.Fragment, { children: a || void 0 }, void 0);
}
function Mh(e, t, n) {
	if (t.type === "element") return Nh(e, t, n);
	if (t.type === "mdxFlowExpression" || t.type === "mdxTextExpression") return Ph(e, t);
	if (t.type === "mdxJsxFlowElement" || t.type === "mdxJsxTextElement") return Ih(e, t, n);
	if (t.type === "mdxjsEsm") return Fh(e, t);
	if (t.type === "root") return Lh(e, t, n);
	if (t.type === "text") return Rh(e, t);
}
function Nh(e, t, n) {
	let r = e.schema, i = r;
	t.tagName.toLowerCase() === "svg" && r.space === "html" && (i = lh, e.schema = i), e.ancestors.push(t);
	let a = Jh(e, t.tagName, !1), o = Uh(e, t), s = Gh(e, t);
	return Oh.has(t.tagName) && (s = s.filter(function(e) {
		return typeof e != "string" || !km(e);
	})), zh(e, o, a, t), Bh(o, s), e.ancestors.pop(), e.schema = r, e.create(t, a, o, n);
}
function Ph(e, t) {
	if (t.data && t.data.estree && e.evaluater) {
		let n = t.data.estree.body[0];
		return n.type, e.evaluater.evaluateExpression(n.expression);
	}
	Yh(e, t.position);
}
function Fh(e, t) {
	if (t.data && t.data.estree && e.evaluater) return e.evaluater.evaluateProgram(t.data.estree);
	Yh(e, t.position);
}
function Ih(e, t, n) {
	let r = e.schema, i = r;
	t.name === "svg" && r.space === "html" && (i = lh, e.schema = i), e.ancestors.push(t);
	let a = t.name === null ? e.Fragment : Jh(e, t.name, !0), o = Wh(e, t), s = Gh(e, t);
	return zh(e, o, a, t), Bh(o, s), e.ancestors.pop(), e.schema = r, e.create(t, a, o, n);
}
function Lh(e, t, n) {
	let r = {};
	return Bh(r, Gh(e, t)), e.create(t, e.Fragment, r, n);
}
function Rh(e, t) {
	return t.value;
}
function zh(e, t, n, r) {
	typeof n != "string" && n !== e.Fragment && e.passNode && (t.node = r);
}
function Bh(e, t) {
	if (t.length > 0) {
		let n = t.length > 1 ? t : t[0];
		n && (e.children = n);
	}
}
function Vh(e, t, n) {
	return r;
	function r(e, r, i, a) {
		let o = Array.isArray(i.children) ? n : t;
		return a ? o(r, i, a) : o(r, i);
	}
}
function Hh(e, t) {
	return n;
	function n(n, r, i, a) {
		let o = Array.isArray(i.children), s = gh(n);
		return t(r, i, a, o, {
			columnNumber: s ? s.column - 1 : void 0,
			fileName: e,
			lineNumber: s ? s.line : void 0
		}, void 0);
	}
}
function Uh(e, t) {
	let n = {}, r, i;
	for (i in t.properties) if (i !== "children" && Th.call(t.properties, i)) {
		let a = Kh(e, i, t.properties[i]);
		if (a) {
			let [i, o] = a;
			e.tableCellAlignToStyle && i === "align" && typeof o == "string" && kh.has(t.tagName) ? r = o : n[i] = o;
		}
	}
	if (r) {
		let t = n.style ||= {};
		t[e.stylePropertyNameCase === "css" ? "text-align" : "textAlign"] = r;
	}
	return n;
}
function Wh(e, t) {
	let n = {};
	for (let r of t.attributes) if (r.type === "mdxJsxExpressionAttribute") {
		if (r.data && r.data.estree && e.evaluater) {
			let t = r.data.estree.body[0];
			t.type;
			let i = t.expression;
			i.type;
			let a = i.properties[0];
			a.type, Object.assign(n, e.evaluater.evaluateExpression(a.argument));
		} else Yh(e, t.position);
	} else {
		let i = r.name, a;
		if (r.value && typeof r.value == "object") {
			if (r.value.data && r.value.data.estree && e.evaluater) {
				let t = r.value.data.estree.body[0];
				t.type, a = e.evaluater.evaluateExpression(t.expression);
			} else Yh(e, t.position);
		} else a = r.value === null || r.value;
		n[i] = a;
	}
	return n;
}
function Gh(e, t) {
	let n = [], r = -1, i = e.passKeys ? /* @__PURE__ */ new Map() : Eh;
	for (; ++r < t.children.length;) {
		let a = t.children[r], o;
		if (e.passKeys) {
			let e = a.type === "element" ? a.tagName : a.type === "mdxJsxFlowElement" || a.type === "mdxJsxTextElement" ? a.name : void 0;
			if (e) {
				let t = i.get(e) || 0;
				o = e + "-" + t, i.set(e, t + 1);
			}
		}
		let s = Mh(e, a, o);
		s !== void 0 && n.push(s);
	}
	return n;
}
function Kh(e, t, n) {
	let r = ah(e.schema, t);
	if (!(n == null || typeof n == "number" && Number.isNaN(n))) {
		if (Array.isArray(n) && (n = r.commaSeparated ? Cm(n) : uh(n)), r.property === "style") {
			let t = typeof n == "object" ? n : qh(e, String(n));
			return e.stylePropertyNameCase === "css" && (t = Xh(t)), ["style", t];
		}
		return [e.elementAttributeNameCase === "react" && r.space ? th[r.property] || r.property : r.attribute, n];
	}
}
function qh(e, t) {
	try {
		return (0, wh.default)(t, { reactCompat: !0 });
	} catch (t) {
		if (e.ignoreInvalidStyle) return {};
		let n = t, r = new Ch("Cannot parse `style` attribute", {
			ancestors: e.ancestors,
			cause: n,
			ruleId: "style",
			source: "hast-util-to-jsx-runtime"
		});
		throw r.file = e.filePath || void 0, r.url = Ah + "#cannot-parse-style-attribute", r;
	}
}
function Jh(e, t, n) {
	let r;
	if (!n) r = {
		type: "Literal",
		value: t
	};
	else if (t.includes(".")) {
		let e = t.split("."), n = -1, i;
		for (; ++n < e.length;) {
			let t = Dm(e[n]) ? {
				type: "Identifier",
				name: e[n]
			} : {
				type: "Literal",
				value: e[n]
			};
			i = i ? {
				type: "MemberExpression",
				object: i,
				property: t,
				computed: !!(n && t.type === "Literal"),
				optional: !1
			} : t;
		}
		r = i;
	} else r = Dm(t) && !/^[a-z]/.test(t) ? {
		type: "Identifier",
		name: t
	} : {
		type: "Literal",
		value: t
	};
	if (r.type === "Literal") {
		let t = r.value;
		return Th.call(e.components, t) ? e.components[t] : t;
	}
	if (e.evaluater) return e.evaluater.evaluateExpression(r);
	Yh(e);
}
function Yh(e, t) {
	let n = new Ch("Cannot handle MDX estrees without `createEvaluater`", {
		ancestors: e.ancestors,
		place: t,
		ruleId: "mdx-estree",
		source: "hast-util-to-jsx-runtime"
	});
	throw n.file = e.filePath || void 0, n.url = Ah + "#cannot-handle-mdx-estrees-without-createevaluater", n;
}
function Xh(e) {
	let t = {}, n;
	for (n in e) Th.call(e, n) && (t[Zh(n)] = e[n]);
	return t;
}
function Zh(e) {
	let t = e.replace(Dh, Qh);
	return t.slice(0, 3) === "ms-" && (t = "-" + t), t;
}
function Qh(e) {
	return "-" + e.toLowerCase();
}
//#endregion
//#region node_modules/html-url-attributes/lib/index.js
var $h = {
	action: ["form"],
	cite: [
		"blockquote",
		"del",
		"ins",
		"q"
	],
	data: ["object"],
	formAction: ["button", "input"],
	href: [
		"a",
		"area",
		"base",
		"link"
	],
	icon: ["menuitem"],
	itemId: null,
	manifest: ["html"],
	ping: ["a", "area"],
	poster: ["video"],
	src: [
		"audio",
		"embed",
		"iframe",
		"img",
		"input",
		"script",
		"source",
		"track",
		"video"
	]
}, eg = {};
function tg(e, t) {
	let n = t || eg;
	return ng(e, typeof n.includeImageAlt != "boolean" || n.includeImageAlt, typeof n.includeHtml != "boolean" || n.includeHtml);
}
function ng(e, t, n) {
	if (ig(e)) {
		if ("value" in e) return e.type === "html" && !n ? "" : e.value;
		if (t && "alt" in e && e.alt) return e.alt;
		if ("children" in e) return rg(e.children, t, n);
	}
	return Array.isArray(e) ? rg(e, t, n) : "";
}
function rg(e, t, n) {
	let r = [], i = -1;
	for (; ++i < e.length;) r[i] = ng(e[i], t, n);
	return r.join("");
}
function ig(e) {
	return !!(e && typeof e == "object");
}
//#endregion
//#region node_modules/decode-named-character-reference/index.dom.js
var ag = document.createElement("i");
function og(e) {
	let t = "&" + e + ";";
	ag.innerHTML = t;
	let n = ag.textContent;
	return n.charCodeAt(n.length - 1) === 59 && e !== "semi" ? !1 : n !== t && n;
}
//#endregion
//#region node_modules/micromark-util-chunked/index.js
function sg(e, t, n, r) {
	let i = e.length, a = 0, o;
	if (t = t < 0 ? -t > i ? 0 : i + t : t > i ? i : t, n = n > 0 ? n : 0, r.length < 1e4) o = Array.from(r), o.unshift(t, n), e.splice(...o);
	else for (n && e.splice(t, n); a < r.length;) o = r.slice(a, a + 1e4), o.unshift(t, 0), e.splice(...o), a += 1e4, t += 1e4;
}
function cg(e, t) {
	return e.length > 0 ? (sg(e, e.length, 0, t), e) : t;
}
//#endregion
//#region node_modules/micromark-util-combine-extensions/index.js
var lg = {}.hasOwnProperty;
function ug(e) {
	let t = {}, n = -1;
	for (; ++n < e.length;) dg(t, e[n]);
	return t;
}
function dg(e, t) {
	let n;
	for (n in t) {
		let r = (lg.call(e, n) ? e[n] : void 0) || (e[n] = {}), i = t[n], a;
		if (i) for (a in i) {
			lg.call(r, a) || (r[a] = []);
			let e = i[a];
			fg(r[a], Array.isArray(e) ? e : e ? [e] : []);
		}
	}
}
function fg(e, t) {
	let n = -1, r = [];
	for (; ++n < t.length;) (t[n].add === "after" ? e : r).push(t[n]);
	sg(e, 0, 0, r);
}
//#endregion
//#region node_modules/micromark-util-decode-numeric-character-reference/index.js
function pg(e, t) {
	let n = Number.parseInt(e, t);
	return n < 9 || n === 11 || n > 13 && n < 32 || n > 126 && n < 160 || n > 55295 && n < 57344 || n > 64975 && n < 65008 || (n & 65535) == 65535 || (n & 65535) == 65534 || n > 1114111 ? "�" : String.fromCodePoint(n);
}
//#endregion
//#region node_modules/micromark-util-normalize-identifier/index.js
function mg(e) {
	return e.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}
//#endregion
//#region node_modules/micromark-util-character/index.js
var hg = Tg(/[A-Za-z]/), gg = Tg(/[\dA-Za-z]/), _g = Tg(/[#-'*+\--9=?A-Z^-~]/);
function vg(e) {
	return e !== null && (e < 32 || e === 127);
}
var yg = Tg(/\d/), bg = Tg(/[\dA-Fa-f]/), xg = Tg(/[!-/:-@[-`{-~]/);
function Z(e) {
	return e !== null && e < -2;
}
function Sg(e) {
	return e !== null && (e < 0 || e === 32);
}
function Q(e) {
	return e === -2 || e === -1 || e === 32;
}
var Cg = Tg(/\p{P}|\p{S}/u), wg = Tg(/\s/);
function Tg(e) {
	return t;
	function t(t) {
		return t !== null && t > -1 && e.test(String.fromCharCode(t));
	}
}
//#endregion
//#region node_modules/micromark-util-sanitize-uri/index.js
function Eg(e) {
	let t = [], n = -1, r = 0, i = 0;
	for (; ++n < e.length;) {
		let a = e.charCodeAt(n), o = "";
		if (a === 37 && gg(e.charCodeAt(n + 1)) && gg(e.charCodeAt(n + 2))) i = 2;
		else if (a < 128) /[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(a)) || (o = String.fromCharCode(a));
		else if (a > 55295 && a < 57344) {
			let t = e.charCodeAt(n + 1);
			a < 56320 && t > 56319 && t < 57344 ? (o = String.fromCharCode(a, t), i = 1) : o = "�";
		} else o = String.fromCharCode(a);
		o &&= (t.push(e.slice(r, n), encodeURIComponent(o)), r = n + i + 1, ""), i &&= (n += i, 0);
	}
	return t.join("") + e.slice(r);
}
//#endregion
//#region node_modules/micromark-factory-space/index.js
function $(e, t, n, r) {
	let i = r ? r - 1 : Infinity, a = 0;
	return o;
	function o(r) {
		return Q(r) ? (e.enter(n), s(r)) : t(r);
	}
	function s(r) {
		return Q(r) && a++ < i ? (e.consume(r), s) : (e.exit(n), t(r));
	}
}
//#endregion
//#region node_modules/micromark/lib/initialize/content.js
var Dg = { tokenize: Og };
function Og(e) {
	let t = e.attempt(this.parser.constructs.contentInitial, r, i), n;
	return t;
	function r(n) {
		if (n === null) {
			e.consume(n);
			return;
		}
		return e.enter("lineEnding"), e.consume(n), e.exit("lineEnding"), $(e, t, "linePrefix");
	}
	function i(t) {
		return e.enter("paragraph"), a(t);
	}
	function a(t) {
		let r = e.enter("chunkText", {
			contentType: "text",
			previous: n
		});
		return n && (n.next = r), n = r, o(t);
	}
	function o(t) {
		if (t === null) {
			e.exit("chunkText"), e.exit("paragraph"), e.consume(t);
			return;
		}
		return Z(t) ? (e.consume(t), e.exit("chunkText"), a) : (e.consume(t), o);
	}
}
//#endregion
//#region node_modules/micromark/lib/initialize/document.js
var kg = { tokenize: jg }, Ag = { tokenize: Mg };
function jg(e) {
	let t = this, n = [], r = 0, i, a, o;
	return s;
	function s(i) {
		if (r < n.length) {
			let a = n[r];
			return t.containerState = a[1], e.attempt(a[0].continuation, c, l)(i);
		}
		return l(i);
	}
	function c(e) {
		if (r++, t.containerState._closeFlow) {
			t.containerState._closeFlow = void 0, i && v();
			let n = t.events.length, a = n, o;
			for (; a--;) if (t.events[a][0] === "exit" && t.events[a][1].type === "chunkFlow") {
				o = t.events[a][1].end;
				break;
			}
			_(r);
			let s = n;
			for (; s < t.events.length;) t.events[s][1].end = { ...o }, s++;
			return sg(t.events, a + 1, 0, t.events.slice(n)), t.events.length = s, l(e);
		}
		return s(e);
	}
	function l(a) {
		if (r === n.length) {
			if (!i) return f(a);
			if (i.currentConstruct && i.currentConstruct.concrete) return m(a);
			t.interrupt = !(!i.currentConstruct || i._gfmTableDynamicInterruptHack);
		}
		return t.containerState = {}, e.check(Ag, u, d)(a);
	}
	function u(e) {
		return i && v(), _(r), f(e);
	}
	function d(e) {
		return t.parser.lazy[t.now().line] = r !== n.length, o = t.now().offset, m(e);
	}
	function f(n) {
		return t.containerState = {}, e.attempt(Ag, p, m)(n);
	}
	function p(e) {
		return r++, n.push([t.currentConstruct, t.containerState]), f(e);
	}
	function m(n) {
		if (n === null) {
			i && v(), _(0), e.consume(n);
			return;
		}
		return i ||= t.parser.flow(t.now()), e.enter("chunkFlow", {
			_tokenizer: i,
			contentType: "flow",
			previous: a
		}), h(n);
	}
	function h(n) {
		if (n === null) {
			g(e.exit("chunkFlow"), !0), _(0), e.consume(n);
			return;
		}
		return Z(n) ? (e.consume(n), g(e.exit("chunkFlow")), r = 0, t.interrupt = void 0, s) : (e.consume(n), h);
	}
	function g(e, n) {
		let s = t.sliceStream(e);
		if (n && s.push(null), e.previous = a, a && (a.next = e), a = e, i.defineSkip(e.start), i.write(s), t.parser.lazy[e.start.line]) {
			let e = i.events.length;
			for (; e--;) if (i.events[e][1].start.offset < o && (!i.events[e][1].end || i.events[e][1].end.offset > o)) return;
			let n = t.events.length, a = n, s, c;
			for (; a--;) if (t.events[a][0] === "exit" && t.events[a][1].type === "chunkFlow") {
				if (s) {
					c = t.events[a][1].end;
					break;
				}
				s = !0;
			}
			for (_(r), e = n; e < t.events.length;) t.events[e][1].end = { ...c }, e++;
			sg(t.events, a + 1, 0, t.events.slice(n)), t.events.length = e;
		}
	}
	function _(r) {
		let i = n.length;
		for (; i-- > r;) {
			let r = n[i];
			t.containerState = r[1], r[0].exit.call(t, e);
		}
		n.length = r;
	}
	function v() {
		i.write([null]), a = void 0, i = void 0, t.containerState._closeFlow = void 0;
	}
}
function Mg(e, t, n) {
	return $(e, e.attempt(this.parser.constructs.document, t, n), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}
//#endregion
//#region node_modules/micromark-util-classify-character/index.js
function Ng(e) {
	if (e === null || Sg(e) || wg(e)) return 1;
	if (Cg(e)) return 2;
}
//#endregion
//#region node_modules/micromark-util-resolve-all/index.js
function Pg(e, t, n) {
	let r = [], i = -1;
	for (; ++i < e.length;) {
		let a = e[i].resolveAll;
		a && !r.includes(a) && (t = a(t, n), r.push(a));
	}
	return t;
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/attention.js
var Fg = {
	name: "attention",
	resolveAll: Ig,
	tokenize: Lg
};
function Ig(e, t) {
	let n = -1, r, i, a, o, s, c, l, u;
	for (; ++n < e.length;) if (e[n][0] === "enter" && e[n][1].type === "attentionSequence" && e[n][1]._close) {
		for (r = n; r--;) if (e[r][0] === "exit" && e[r][1].type === "attentionSequence" && e[r][1]._open && t.sliceSerialize(e[r][1]).charCodeAt(0) === t.sliceSerialize(e[n][1]).charCodeAt(0)) {
			if ((e[r][1]._close || e[n][1]._open) && (e[n][1].end.offset - e[n][1].start.offset) % 3 && !((e[r][1].end.offset - e[r][1].start.offset + e[n][1].end.offset - e[n][1].start.offset) % 3)) continue;
			c = e[r][1].end.offset - e[r][1].start.offset > 1 && e[n][1].end.offset - e[n][1].start.offset > 1 ? 2 : 1;
			let d = { ...e[r][1].end }, f = { ...e[n][1].start };
			Rg(d, -c), Rg(f, c), o = {
				type: c > 1 ? "strongSequence" : "emphasisSequence",
				start: d,
				end: { ...e[r][1].end }
			}, s = {
				type: c > 1 ? "strongSequence" : "emphasisSequence",
				start: { ...e[n][1].start },
				end: f
			}, a = {
				type: c > 1 ? "strongText" : "emphasisText",
				start: { ...e[r][1].end },
				end: { ...e[n][1].start }
			}, i = {
				type: c > 1 ? "strong" : "emphasis",
				start: { ...o.start },
				end: { ...s.end }
			}, e[r][1].end = { ...o.start }, e[n][1].start = { ...s.end }, l = [], e[r][1].end.offset - e[r][1].start.offset && (l = cg(l, [[
				"enter",
				e[r][1],
				t
			], [
				"exit",
				e[r][1],
				t
			]])), l = cg(l, [
				[
					"enter",
					i,
					t
				],
				[
					"enter",
					o,
					t
				],
				[
					"exit",
					o,
					t
				],
				[
					"enter",
					a,
					t
				]
			]), l = cg(l, Pg(t.parser.constructs.insideSpan.null, e.slice(r + 1, n), t)), l = cg(l, [
				[
					"exit",
					a,
					t
				],
				[
					"enter",
					s,
					t
				],
				[
					"exit",
					s,
					t
				],
				[
					"exit",
					i,
					t
				]
			]), e[n][1].end.offset - e[n][1].start.offset ? (u = 2, l = cg(l, [[
				"enter",
				e[n][1],
				t
			], [
				"exit",
				e[n][1],
				t
			]])) : u = 0, sg(e, r - 1, n - r + 3, l), n = r + l.length - u - 2;
			break;
		}
	}
	for (n = -1; ++n < e.length;) e[n][1].type === "attentionSequence" && (e[n][1].type = "data");
	return e;
}
function Lg(e, t) {
	let n = this.parser.constructs.attentionMarkers.null, r = this.previous, i = Ng(r), a;
	return o;
	function o(t) {
		return a = t, e.enter("attentionSequence"), s(t);
	}
	function s(o) {
		if (o === a) return e.consume(o), s;
		let c = e.exit("attentionSequence"), l = Ng(o), u = !l || l === 2 && i || n.includes(o), d = !i || i === 2 && l || n.includes(r);
		return c._open = !!(a === 42 ? u : u && (i || !d)), c._close = !!(a === 42 ? d : d && (l || !u)), t(o);
	}
}
function Rg(e, t) {
	e.column += t, e.offset += t, e._bufferIndex += t;
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/autolink.js
var zg = {
	name: "autolink",
	tokenize: Bg
};
function Bg(e, t, n) {
	let r = 0;
	return i;
	function i(t) {
		return e.enter("autolink"), e.enter("autolinkMarker"), e.consume(t), e.exit("autolinkMarker"), e.enter("autolinkProtocol"), a;
	}
	function a(t) {
		return hg(t) ? (e.consume(t), o) : t === 64 ? n(t) : l(t);
	}
	function o(e) {
		return e === 43 || e === 45 || e === 46 || gg(e) ? (r = 1, s(e)) : l(e);
	}
	function s(t) {
		return t === 58 ? (e.consume(t), r = 0, c) : (t === 43 || t === 45 || t === 46 || gg(t)) && r++ < 32 ? (e.consume(t), s) : (r = 0, l(t));
	}
	function c(r) {
		return r === 62 ? (e.exit("autolinkProtocol"), e.enter("autolinkMarker"), e.consume(r), e.exit("autolinkMarker"), e.exit("autolink"), t) : r === null || r === 32 || r === 60 || vg(r) ? n(r) : (e.consume(r), c);
	}
	function l(t) {
		return t === 64 ? (e.consume(t), u) : _g(t) ? (e.consume(t), l) : n(t);
	}
	function u(e) {
		return gg(e) ? d(e) : n(e);
	}
	function d(n) {
		return n === 46 ? (e.consume(n), r = 0, u) : n === 62 ? (e.exit("autolinkProtocol").type = "autolinkEmail", e.enter("autolinkMarker"), e.consume(n), e.exit("autolinkMarker"), e.exit("autolink"), t) : f(n);
	}
	function f(t) {
		if ((t === 45 || gg(t)) && r++ < 63) {
			let n = t === 45 ? f : d;
			return e.consume(t), n;
		}
		return n(t);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/blank-line.js
var Vg = {
	partial: !0,
	tokenize: Hg
};
function Hg(e, t, n) {
	return r;
	function r(t) {
		return Q(t) ? $(e, i, "linePrefix")(t) : i(t);
	}
	function i(e) {
		return e === null || Z(e) ? t(e) : n(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/block-quote.js
var Ug = {
	continuation: { tokenize: Gg },
	exit: Kg,
	name: "blockQuote",
	tokenize: Wg
};
function Wg(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		if (t === 62) {
			let n = r.containerState;
			return n.open ||= (e.enter("blockQuote", { _container: !0 }), !0), e.enter("blockQuotePrefix"), e.enter("blockQuoteMarker"), e.consume(t), e.exit("blockQuoteMarker"), a;
		}
		return n(t);
	}
	function a(n) {
		return Q(n) ? (e.enter("blockQuotePrefixWhitespace"), e.consume(n), e.exit("blockQuotePrefixWhitespace"), e.exit("blockQuotePrefix"), t) : (e.exit("blockQuotePrefix"), t(n));
	}
}
function Gg(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return Q(t) ? $(e, a, "linePrefix", r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(t) : a(t);
	}
	function a(r) {
		return e.attempt(Ug, t, n)(r);
	}
}
function Kg(e) {
	e.exit("blockQuote");
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/character-escape.js
var qg = {
	name: "characterEscape",
	tokenize: Jg
};
function Jg(e, t, n) {
	return r;
	function r(t) {
		return e.enter("characterEscape"), e.enter("escapeMarker"), e.consume(t), e.exit("escapeMarker"), i;
	}
	function i(r) {
		return xg(r) ? (e.enter("characterEscapeValue"), e.consume(r), e.exit("characterEscapeValue"), e.exit("characterEscape"), t) : n(r);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/character-reference.js
var Yg = {
	name: "characterReference",
	tokenize: Xg
};
function Xg(e, t, n) {
	let r = this, i = 0, a, o;
	return s;
	function s(t) {
		return e.enter("characterReference"), e.enter("characterReferenceMarker"), e.consume(t), e.exit("characterReferenceMarker"), c;
	}
	function c(t) {
		return t === 35 ? (e.enter("characterReferenceMarkerNumeric"), e.consume(t), e.exit("characterReferenceMarkerNumeric"), l) : (e.enter("characterReferenceValue"), a = 31, o = gg, u(t));
	}
	function l(t) {
		return t === 88 || t === 120 ? (e.enter("characterReferenceMarkerHexadecimal"), e.consume(t), e.exit("characterReferenceMarkerHexadecimal"), e.enter("characterReferenceValue"), a = 6, o = bg, u) : (e.enter("characterReferenceValue"), a = 7, o = yg, u(t));
	}
	function u(s) {
		if (s === 59 && i) {
			let i = e.exit("characterReferenceValue");
			return o === gg && !og(r.sliceSerialize(i)) ? n(s) : (e.enter("characterReferenceMarker"), e.consume(s), e.exit("characterReferenceMarker"), e.exit("characterReference"), t);
		}
		return o(s) && i++ < a ? (e.consume(s), u) : n(s);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/code-fenced.js
var Zg = {
	partial: !0,
	tokenize: e_
}, Qg = {
	concrete: !0,
	name: "codeFenced",
	tokenize: $g
};
function $g(e, t, n) {
	let r = this, i = {
		partial: !0,
		tokenize: x
	}, a = 0, o = 0, s;
	return c;
	function c(e) {
		return l(e);
	}
	function l(t) {
		let n = r.events[r.events.length - 1];
		return a = n && n[1].type === "linePrefix" ? n[2].sliceSerialize(n[1], !0).length : 0, s = t, e.enter("codeFenced"), e.enter("codeFencedFence"), e.enter("codeFencedFenceSequence"), u(t);
	}
	function u(t) {
		return t === s ? (o++, e.consume(t), u) : o < 3 ? n(t) : (e.exit("codeFencedFenceSequence"), Q(t) ? $(e, d, "whitespace")(t) : d(t));
	}
	function d(n) {
		return n === null || Z(n) ? (e.exit("codeFencedFence"), r.interrupt ? t(n) : e.check(Zg, h, b)(n)) : (e.enter("codeFencedFenceInfo"), e.enter("chunkString", { contentType: "string" }), f(n));
	}
	function f(t) {
		return t === null || Z(t) ? (e.exit("chunkString"), e.exit("codeFencedFenceInfo"), d(t)) : Q(t) ? (e.exit("chunkString"), e.exit("codeFencedFenceInfo"), $(e, p, "whitespace")(t)) : t === 96 && t === s ? n(t) : (e.consume(t), f);
	}
	function p(t) {
		return t === null || Z(t) ? d(t) : (e.enter("codeFencedFenceMeta"), e.enter("chunkString", { contentType: "string" }), m(t));
	}
	function m(t) {
		return t === null || Z(t) ? (e.exit("chunkString"), e.exit("codeFencedFenceMeta"), d(t)) : t === 96 && t === s ? n(t) : (e.consume(t), m);
	}
	function h(t) {
		return e.attempt(i, b, g)(t);
	}
	function g(t) {
		return e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), _;
	}
	function _(t) {
		return a > 0 && Q(t) ? $(e, v, "linePrefix", a + 1)(t) : v(t);
	}
	function v(t) {
		return t === null || Z(t) ? e.check(Zg, h, b)(t) : (e.enter("codeFlowValue"), y(t));
	}
	function y(t) {
		return t === null || Z(t) ? (e.exit("codeFlowValue"), v(t)) : (e.consume(t), y);
	}
	function b(n) {
		return e.exit("codeFenced"), t(n);
	}
	function x(e, t, n) {
		let i = 0;
		return a;
		function a(t) {
			return e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), c;
		}
		function c(t) {
			return e.enter("codeFencedFence"), Q(t) ? $(e, l, "linePrefix", r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(t) : l(t);
		}
		function l(t) {
			return t === s ? (e.enter("codeFencedFenceSequence"), u(t)) : n(t);
		}
		function u(t) {
			return t === s ? (i++, e.consume(t), u) : i >= o ? (e.exit("codeFencedFenceSequence"), Q(t) ? $(e, d, "whitespace")(t) : d(t)) : n(t);
		}
		function d(r) {
			return r === null || Z(r) ? (e.exit("codeFencedFence"), t(r)) : n(r);
		}
	}
}
function e_(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return t === null ? n(t) : (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), a);
	}
	function a(e) {
		return r.parser.lazy[r.now().line] ? n(e) : t(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/code-indented.js
var t_ = {
	name: "codeIndented",
	tokenize: r_
}, n_ = {
	partial: !0,
	tokenize: i_
};
function r_(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return e.enter("codeIndented"), $(e, a, "linePrefix", 5)(t);
	}
	function a(e) {
		let t = r.events[r.events.length - 1];
		return t && t[1].type === "linePrefix" && t[2].sliceSerialize(t[1], !0).length >= 4 ? o(e) : n(e);
	}
	function o(t) {
		return t === null ? c(t) : Z(t) ? e.attempt(n_, o, c)(t) : (e.enter("codeFlowValue"), s(t));
	}
	function s(t) {
		return t === null || Z(t) ? (e.exit("codeFlowValue"), o(t)) : (e.consume(t), s);
	}
	function c(n) {
		return e.exit("codeIndented"), t(n);
	}
}
function i_(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return r.parser.lazy[r.now().line] ? n(t) : Z(t) ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), i) : $(e, a, "linePrefix", 5)(t);
	}
	function a(e) {
		let a = r.events[r.events.length - 1];
		return a && a[1].type === "linePrefix" && a[2].sliceSerialize(a[1], !0).length >= 4 ? t(e) : Z(e) ? i(e) : n(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/code-text.js
var a_ = {
	name: "codeText",
	previous: s_,
	resolve: o_,
	tokenize: c_
};
function o_(e) {
	let t = e.length - 4, n = 3, r, i;
	if ((e[n][1].type === "lineEnding" || e[n][1].type === "space") && (e[t][1].type === "lineEnding" || e[t][1].type === "space")) {
		for (r = n; ++r < t;) if (e[r][1].type === "codeTextData") {
			e[n][1].type = "codeTextPadding", e[t][1].type = "codeTextPadding", n += 2, t -= 2;
			break;
		}
	}
	for (r = n - 1, t++; ++r <= t;) i === void 0 ? r !== t && e[r][1].type !== "lineEnding" && (i = r) : (r === t || e[r][1].type === "lineEnding") && (e[i][1].type = "codeTextData", r !== i + 2 && (e[i][1].end = e[r - 1][1].end, e.splice(i + 2, r - i - 2), t -= r - i - 2, r = i + 2), i = void 0);
	return e;
}
function s_(e) {
	return e !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
function c_(e, t, n) {
	let r = 0, i, a;
	return o;
	function o(t) {
		return e.enter("codeText"), e.enter("codeTextSequence"), s(t);
	}
	function s(t) {
		return t === 96 ? (e.consume(t), r++, s) : (e.exit("codeTextSequence"), c(t));
	}
	function c(t) {
		return t === null ? n(t) : t === 32 ? (e.enter("space"), e.consume(t), e.exit("space"), c) : t === 96 ? (a = e.enter("codeTextSequence"), i = 0, u(t)) : Z(t) ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), c) : (e.enter("codeTextData"), l(t));
	}
	function l(t) {
		return t === null || t === 32 || t === 96 || Z(t) ? (e.exit("codeTextData"), c(t)) : (e.consume(t), l);
	}
	function u(n) {
		return n === 96 ? (e.consume(n), i++, u) : i === r ? (e.exit("codeTextSequence"), e.exit("codeText"), t(n)) : (a.type = "codeTextData", l(n));
	}
}
//#endregion
//#region node_modules/micromark-util-subtokenize/lib/splice-buffer.js
var l_ = class {
	constructor(e) {
		this.left = e ? [...e] : [], this.right = [];
	}
	get(e) {
		if (e < 0 || e >= this.left.length + this.right.length) throw RangeError("Cannot access index `" + e + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
		return e < this.left.length ? this.left[e] : this.right[this.right.length - e + this.left.length - 1];
	}
	get length() {
		return this.left.length + this.right.length;
	}
	shift() {
		return this.setCursor(0), this.right.pop();
	}
	slice(e, t) {
		let n = t ?? Infinity;
		return n < this.left.length ? this.left.slice(e, n) : e > this.left.length ? this.right.slice(this.right.length - n + this.left.length, this.right.length - e + this.left.length).reverse() : this.left.slice(e).concat(this.right.slice(this.right.length - n + this.left.length).reverse());
	}
	splice(e, t, n) {
		let r = t || 0;
		this.setCursor(Math.trunc(e));
		let i = this.right.splice(this.right.length - r, Infinity);
		return n && u_(this.left, n), i.reverse();
	}
	pop() {
		return this.setCursor(Infinity), this.left.pop();
	}
	push(e) {
		this.setCursor(Infinity), this.left.push(e);
	}
	pushMany(e) {
		this.setCursor(Infinity), u_(this.left, e);
	}
	unshift(e) {
		this.setCursor(0), this.right.push(e);
	}
	unshiftMany(e) {
		this.setCursor(0), u_(this.right, e.reverse());
	}
	setCursor(e) {
		if (!(e === this.left.length || e > this.left.length && this.right.length === 0 || e < 0 && this.left.length === 0)) {
			if (e < this.left.length) {
				let t = this.left.splice(e, Infinity);
				u_(this.right, t.reverse());
			} else {
				let t = this.right.splice(this.left.length + this.right.length - e, Infinity);
				u_(this.left, t.reverse());
			}
		}
	}
};
function u_(e, t) {
	let n = 0;
	if (t.length < 1e4) e.push(...t);
	else for (; n < t.length;) e.push(...t.slice(n, n + 1e4)), n += 1e4;
}
//#endregion
//#region node_modules/micromark-util-subtokenize/index.js
function d_(e) {
	let t = {}, n = -1, r, i, a, o, s, c, l, u = new l_(e);
	for (; ++n < u.length;) {
		for (; n in t;) n = t[n];
		if (r = u.get(n), n && r[1].type === "chunkFlow" && u.get(n - 1)[1].type === "listItemPrefix" && (c = r[1]._tokenizer.events, a = 0, a < c.length && c[a][1].type === "lineEndingBlank" && (a += 2), a < c.length && c[a][1].type === "content")) for (; ++a < c.length && c[a][1].type !== "content";) c[a][1].type === "chunkText" && (c[a][1]._isInFirstContentOfListItem = !0, a++);
		if (r[0] === "enter") r[1].contentType && (Object.assign(t, f_(u, n)), n = t[n], l = !0);
		else if (r[1]._container) {
			for (a = n, i = void 0; a--;) if (o = u.get(a), o[1].type === "lineEnding" || o[1].type === "lineEndingBlank") o[0] === "enter" && (i && (u.get(i)[1].type = "lineEndingBlank"), o[1].type = "lineEnding", i = a);
			else if (o[1].type !== "linePrefix" && o[1].type !== "listItemIndent") break;
			i && (r[1].end = { ...u.get(i)[1].start }, s = u.slice(i, n), s.unshift(r), u.splice(i, n - i + 1, s));
		}
	}
	return sg(e, 0, Infinity, u.slice(0)), !l;
}
function f_(e, t) {
	let n = e.get(t)[1], r = e.get(t)[2], i = t - 1, a = [], o = n._tokenizer;
	o || (o = r.parser[n.contentType](n.start), n._contentTypeTextTrailing && (o._contentTypeTextTrailing = !0));
	let s = o.events, c = [], l = {}, u, d, f = -1, p = n, m = 0, h = 0, g = [h];
	for (; p;) {
		for (; e.get(++i)[1] !== p;);
		a.push(i), p._tokenizer || (u = r.sliceStream(p), p.next || u.push(null), d && o.defineSkip(p.start), p._isInFirstContentOfListItem && (o._gfmTasklistFirstContentOfListItem = !0), o.write(u), p._isInFirstContentOfListItem && (o._gfmTasklistFirstContentOfListItem = void 0)), d = p, p = p.next;
	}
	for (p = n; ++f < s.length;) s[f][0] === "exit" && s[f - 1][0] === "enter" && s[f][1].type === s[f - 1][1].type && s[f][1].start.line !== s[f][1].end.line && (h = f + 1, g.push(h), p._tokenizer = void 0, p.previous = void 0, p = p.next);
	for (o.events = [], p ? (p._tokenizer = void 0, p.previous = void 0) : g.pop(), f = g.length; f--;) {
		let t = s.slice(g[f], g[f + 1]), n = a.pop();
		c.push([n, n + t.length - 1]), e.splice(n, 2, t);
	}
	for (c.reverse(), f = -1; ++f < c.length;) l[m + c[f][0]] = m + c[f][1], m += c[f][1] - c[f][0] - 1;
	return l;
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/content.js
var p_ = {
	resolve: h_,
	tokenize: g_
}, m_ = {
	partial: !0,
	tokenize: __
};
function h_(e) {
	return d_(e), e;
}
function g_(e, t) {
	let n;
	return r;
	function r(t) {
		return e.enter("content"), n = e.enter("chunkContent", { contentType: "content" }), i(t);
	}
	function i(t) {
		return t === null ? a(t) : Z(t) ? e.check(m_, o, a)(t) : (e.consume(t), i);
	}
	function a(n) {
		return e.exit("chunkContent"), e.exit("content"), t(n);
	}
	function o(t) {
		return e.consume(t), e.exit("chunkContent"), n.next = e.enter("chunkContent", {
			contentType: "content",
			previous: n
		}), n = n.next, i;
	}
}
function __(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return e.exit("chunkContent"), e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), $(e, a, "linePrefix");
	}
	function a(i) {
		if (i === null || Z(i)) return n(i);
		let a = r.events[r.events.length - 1];
		return !r.parser.constructs.disable.null.includes("codeIndented") && a && a[1].type === "linePrefix" && a[2].sliceSerialize(a[1], !0).length >= 4 ? t(i) : e.interrupt(r.parser.constructs.flow, n, t)(i);
	}
}
//#endregion
//#region node_modules/micromark-factory-destination/index.js
function v_(e, t, n, r, i, a, o, s, c) {
	let l = c || Infinity, u = 0;
	return d;
	function d(t) {
		return t === 60 ? (e.enter(r), e.enter(i), e.enter(a), e.consume(t), e.exit(a), f) : t === null || t === 32 || t === 41 || vg(t) ? n(t) : (e.enter(r), e.enter(o), e.enter(s), e.enter("chunkString", { contentType: "string" }), h(t));
	}
	function f(n) {
		return n === 62 ? (e.enter(a), e.consume(n), e.exit(a), e.exit(i), e.exit(r), t) : (e.enter(s), e.enter("chunkString", { contentType: "string" }), p(n));
	}
	function p(t) {
		return t === 62 ? (e.exit("chunkString"), e.exit(s), f(t)) : t === null || t === 60 || Z(t) ? n(t) : (e.consume(t), t === 92 ? m : p);
	}
	function m(t) {
		return t === 60 || t === 62 || t === 92 ? (e.consume(t), p) : p(t);
	}
	function h(i) {
		return !u && (i === null || i === 41 || Sg(i)) ? (e.exit("chunkString"), e.exit(s), e.exit(o), e.exit(r), t(i)) : u < l && i === 40 ? (e.consume(i), u++, h) : i === 41 ? (e.consume(i), u--, h) : i === null || i === 32 || i === 40 || vg(i) ? n(i) : (e.consume(i), i === 92 ? g : h);
	}
	function g(t) {
		return t === 40 || t === 41 || t === 92 ? (e.consume(t), h) : h(t);
	}
}
//#endregion
//#region node_modules/micromark-factory-label/index.js
function y_(e, t, n, r, i, a) {
	let o = this, s = 0, c;
	return l;
	function l(t) {
		return e.enter(r), e.enter(i), e.consume(t), e.exit(i), e.enter(a), u;
	}
	function u(l) {
		return s > 999 || l === null || l === 91 || l === 93 && !c ||
		/* c8 ignore next 3 */
		l === 94 && !s && "_hiddenFootnoteSupport" in o.parser.constructs ? n(l) : l === 93 ? (e.exit(a), e.enter(i), e.consume(l), e.exit(i), e.exit(r), t) : Z(l) ? (e.enter("lineEnding"), e.consume(l), e.exit("lineEnding"), u) : (e.enter("chunkString", { contentType: "string" }), d(l));
	}
	function d(t) {
		return t === null || t === 91 || t === 93 || Z(t) || s++ > 999 ? (e.exit("chunkString"), u(t)) : (e.consume(t), c ||= !Q(t), t === 92 ? f : d);
	}
	function f(t) {
		return t === 91 || t === 92 || t === 93 ? (e.consume(t), s++, d) : d(t);
	}
}
//#endregion
//#region node_modules/micromark-factory-title/index.js
function b_(e, t, n, r, i, a) {
	let o;
	return s;
	function s(t) {
		return t === 34 || t === 39 || t === 40 ? (e.enter(r), e.enter(i), e.consume(t), e.exit(i), o = t === 40 ? 41 : t, c) : n(t);
	}
	function c(n) {
		return n === o ? (e.enter(i), e.consume(n), e.exit(i), e.exit(r), t) : (e.enter(a), l(n));
	}
	function l(t) {
		return t === o ? (e.exit(a), c(o)) : t === null ? n(t) : Z(t) ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), $(e, l, "linePrefix")) : (e.enter("chunkString", { contentType: "string" }), u(t));
	}
	function u(t) {
		return t === o || t === null || Z(t) ? (e.exit("chunkString"), l(t)) : (e.consume(t), t === 92 ? d : u);
	}
	function d(t) {
		return t === o || t === 92 ? (e.consume(t), u) : u(t);
	}
}
//#endregion
//#region node_modules/micromark-factory-whitespace/index.js
function x_(e, t) {
	let n;
	return r;
	function r(i) {
		return Z(i) ? (e.enter("lineEnding"), e.consume(i), e.exit("lineEnding"), n = !0, r) : Q(i) ? $(e, r, n ? "linePrefix" : "lineSuffix")(i) : t(i);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/definition.js
var S_ = {
	name: "definition",
	tokenize: w_
}, C_ = {
	partial: !0,
	tokenize: T_
};
function w_(e, t, n) {
	let r = this, i;
	return a;
	function a(t) {
		return e.enter("definition"), o(t);
	}
	function o(t) {
		return y_.call(r, e, s, n, "definitionLabel", "definitionLabelMarker", "definitionLabelString")(t);
	}
	function s(t) {
		return i = mg(r.sliceSerialize(r.events[r.events.length - 1][1]).slice(1, -1)), t === 58 ? (e.enter("definitionMarker"), e.consume(t), e.exit("definitionMarker"), c) : n(t);
	}
	function c(t) {
		return Sg(t) ? x_(e, l)(t) : l(t);
	}
	function l(t) {
		return v_(e, u, n, "definitionDestination", "definitionDestinationLiteral", "definitionDestinationLiteralMarker", "definitionDestinationRaw", "definitionDestinationString")(t);
	}
	function u(t) {
		return e.attempt(C_, d, d)(t);
	}
	function d(t) {
		return Q(t) ? $(e, f, "whitespace")(t) : f(t);
	}
	function f(a) {
		return a === null || Z(a) ? (e.exit("definition"), r.parser.defined.push(i), t(a)) : n(a);
	}
}
function T_(e, t, n) {
	return r;
	function r(t) {
		return Sg(t) ? x_(e, i)(t) : n(t);
	}
	function i(t) {
		return b_(e, a, n, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(t);
	}
	function a(t) {
		return Q(t) ? $(e, o, "whitespace")(t) : o(t);
	}
	function o(e) {
		return e === null || Z(e) ? t(e) : n(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/hard-break-escape.js
var E_ = {
	name: "hardBreakEscape",
	tokenize: D_
};
function D_(e, t, n) {
	return r;
	function r(t) {
		return e.enter("hardBreakEscape"), e.consume(t), i;
	}
	function i(r) {
		return Z(r) ? (e.exit("hardBreakEscape"), t(r)) : n(r);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/heading-atx.js
var O_ = {
	name: "headingAtx",
	resolve: k_,
	tokenize: A_
};
function k_(e, t) {
	let n = e.length - 2, r = 3, i, a;
	return e[r][1].type === "whitespace" && (r += 2), n - 2 > r && e[n][1].type === "whitespace" && (n -= 2), e[n][1].type === "atxHeadingSequence" && (r === n - 1 || n - 4 > r && e[n - 2][1].type === "whitespace") && (n -= r + 1 === n ? 2 : 4), n > r && (i = {
		type: "atxHeadingText",
		start: e[r][1].start,
		end: e[n][1].end
	}, a = {
		type: "chunkText",
		start: e[r][1].start,
		end: e[n][1].end,
		contentType: "text"
	}, sg(e, r, n - r + 1, [
		[
			"enter",
			i,
			t
		],
		[
			"enter",
			a,
			t
		],
		[
			"exit",
			a,
			t
		],
		[
			"exit",
			i,
			t
		]
	])), e;
}
function A_(e, t, n) {
	let r = 0;
	return i;
	function i(t) {
		return e.enter("atxHeading"), a(t);
	}
	function a(t) {
		return e.enter("atxHeadingSequence"), o(t);
	}
	function o(t) {
		return t === 35 && r++ < 6 ? (e.consume(t), o) : t === null || Sg(t) ? (e.exit("atxHeadingSequence"), s(t)) : n(t);
	}
	function s(n) {
		return n === 35 ? (e.enter("atxHeadingSequence"), c(n)) : n === null || Z(n) ? (e.exit("atxHeading"), t(n)) : Q(n) ? $(e, s, "whitespace")(n) : (e.enter("atxHeadingText"), l(n));
	}
	function c(t) {
		return t === 35 ? (e.consume(t), c) : (e.exit("atxHeadingSequence"), s(t));
	}
	function l(t) {
		return t === null || t === 35 || Sg(t) ? (e.exit("atxHeadingText"), s(t)) : (e.consume(t), l);
	}
}
//#endregion
//#region node_modules/micromark-util-html-tag-name/index.js
var j_ = /* @__PURE__ */ "address.article.aside.base.basefont.blockquote.body.caption.center.col.colgroup.dd.details.dialog.dir.div.dl.dt.fieldset.figcaption.figure.footer.form.frame.frameset.h1.h2.h3.h4.h5.h6.head.header.hr.html.iframe.legend.li.link.main.menu.menuitem.nav.noframes.ol.optgroup.option.p.param.search.section.summary.table.tbody.td.tfoot.th.thead.title.tr.track.ul".split("."), M_ = [
	"pre",
	"script",
	"style",
	"textarea"
], N_ = {
	concrete: !0,
	name: "htmlFlow",
	resolveTo: I_,
	tokenize: L_
}, P_ = {
	partial: !0,
	tokenize: z_
}, F_ = {
	partial: !0,
	tokenize: R_
};
function I_(e) {
	let t = e.length;
	for (; t-- && (e[t][0] !== "enter" || e[t][1].type !== "htmlFlow"););
	return t > 1 && e[t - 2][1].type === "linePrefix" && (e[t][1].start = e[t - 2][1].start, e[t + 1][1].start = e[t - 2][1].start, e.splice(t - 2, 2)), e;
}
function L_(e, t, n) {
	let r = this, i, a, o, s, c;
	return l;
	function l(e) {
		return u(e);
	}
	function u(t) {
		return e.enter("htmlFlow"), e.enter("htmlFlowData"), e.consume(t), d;
	}
	function d(s) {
		return s === 33 ? (e.consume(s), f) : s === 47 ? (e.consume(s), a = !0, h) : s === 63 ? (e.consume(s), i = 3, r.interrupt ? t : re) : hg(s) ? (e.consume(s), o = String.fromCharCode(s), g) : n(s);
	}
	function f(a) {
		return a === 45 ? (e.consume(a), i = 2, p) : a === 91 ? (e.consume(a), i = 5, s = 0, m) : hg(a) ? (e.consume(a), i = 4, r.interrupt ? t : re) : n(a);
	}
	function p(i) {
		return i === 45 ? (e.consume(i), r.interrupt ? t : re) : n(i);
	}
	function m(i) {
		return i === "CDATA[".charCodeAt(s++) ? (e.consume(i), s === 6 ? r.interrupt ? t : O : m) : n(i);
	}
	function h(t) {
		return hg(t) ? (e.consume(t), o = String.fromCharCode(t), g) : n(t);
	}
	function g(s) {
		if (s === null || s === 47 || s === 62 || Sg(s)) {
			let c = s === 47, l = o.toLowerCase();
			return !c && !a && M_.includes(l) ? (i = 1, r.interrupt ? t(s) : O(s)) : j_.includes(o.toLowerCase()) ? (i = 6, c ? (e.consume(s), _) : r.interrupt ? t(s) : O(s)) : (i = 7, r.interrupt && !r.parser.lazy[r.now().line] ? n(s) : a ? v(s) : y(s));
		}
		return s === 45 || gg(s) ? (e.consume(s), o += String.fromCharCode(s), g) : n(s);
	}
	function _(i) {
		return i === 62 ? (e.consume(i), r.interrupt ? t : O) : n(i);
	}
	function v(t) {
		return Q(t) ? (e.consume(t), v) : E(t);
	}
	function y(t) {
		return t === 47 ? (e.consume(t), E) : t === 58 || t === 95 || hg(t) ? (e.consume(t), b) : Q(t) ? (e.consume(t), y) : E(t);
	}
	function b(t) {
		return t === 45 || t === 46 || t === 58 || t === 95 || gg(t) ? (e.consume(t), b) : x(t);
	}
	function x(t) {
		return t === 61 ? (e.consume(t), S) : Q(t) ? (e.consume(t), x) : y(t);
	}
	function S(t) {
		return t === null || t === 60 || t === 61 || t === 62 || t === 96 ? n(t) : t === 34 || t === 39 ? (e.consume(t), c = t, C) : Q(t) ? (e.consume(t), S) : w(t);
	}
	function C(t) {
		return t === c ? (e.consume(t), c = null, T) : t === null || Z(t) ? n(t) : (e.consume(t), C);
	}
	function w(t) {
		return t === null || t === 34 || t === 39 || t === 47 || t === 60 || t === 61 || t === 62 || t === 96 || Sg(t) ? x(t) : (e.consume(t), w);
	}
	function T(e) {
		return e === 47 || e === 62 || Q(e) ? y(e) : n(e);
	}
	function E(t) {
		return t === 62 ? (e.consume(t), D) : n(t);
	}
	function D(t) {
		return t === null || Z(t) ? O(t) : Q(t) ? (e.consume(t), D) : n(t);
	}
	function O(t) {
		return t === 45 && i === 2 ? (e.consume(t), te) : t === 60 && i === 1 ? (e.consume(t), ne) : t === 62 && i === 4 ? (e.consume(t), N) : t === 63 && i === 3 ? (e.consume(t), re) : t === 93 && i === 5 ? (e.consume(t), M) : Z(t) && (i === 6 || i === 7) ? (e.exit("htmlFlowData"), e.check(P_, P, k)(t)) : t === null || Z(t) ? (e.exit("htmlFlowData"), k(t)) : (e.consume(t), O);
	}
	function k(t) {
		return e.check(F_, ee, P)(t);
	}
	function ee(t) {
		return e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), A;
	}
	function A(t) {
		return t === null || Z(t) ? k(t) : (e.enter("htmlFlowData"), O(t));
	}
	function te(t) {
		return t === 45 ? (e.consume(t), re) : O(t);
	}
	function ne(t) {
		return t === 47 ? (e.consume(t), o = "", j) : O(t);
	}
	function j(t) {
		if (t === 62) {
			let n = o.toLowerCase();
			return M_.includes(n) ? (e.consume(t), N) : O(t);
		}
		return hg(t) && o.length < 8 ? (e.consume(t), o += String.fromCharCode(t), j) : O(t);
	}
	function M(t) {
		return t === 93 ? (e.consume(t), re) : O(t);
	}
	function re(t) {
		return t === 62 ? (e.consume(t), N) : t === 45 && i === 2 ? (e.consume(t), re) : O(t);
	}
	function N(t) {
		return t === null || Z(t) ? (e.exit("htmlFlowData"), P(t)) : (e.consume(t), N);
	}
	function P(n) {
		return e.exit("htmlFlow"), t(n);
	}
}
function R_(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return Z(t) ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), a) : n(t);
	}
	function a(e) {
		return r.parser.lazy[r.now().line] ? n(e) : t(e);
	}
}
function z_(e, t, n) {
	return r;
	function r(r) {
		return e.enter("lineEnding"), e.consume(r), e.exit("lineEnding"), e.attempt(Vg, t, n);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/html-text.js
var B_ = {
	name: "htmlText",
	tokenize: V_
};
function V_(e, t, n) {
	let r = this, i, a, o;
	return s;
	function s(t) {
		return e.enter("htmlText"), e.enter("htmlTextData"), e.consume(t), c;
	}
	function c(t) {
		return t === 33 ? (e.consume(t), l) : t === 47 ? (e.consume(t), x) : t === 63 ? (e.consume(t), y) : hg(t) ? (e.consume(t), w) : n(t);
	}
	function l(t) {
		return t === 45 ? (e.consume(t), u) : t === 91 ? (e.consume(t), a = 0, m) : hg(t) ? (e.consume(t), v) : n(t);
	}
	function u(t) {
		return t === 45 ? (e.consume(t), p) : n(t);
	}
	function d(t) {
		return t === null ? n(t) : t === 45 ? (e.consume(t), f) : Z(t) ? (o = d, ne(t)) : (e.consume(t), d);
	}
	function f(t) {
		return t === 45 ? (e.consume(t), p) : d(t);
	}
	function p(e) {
		return e === 62 ? te(e) : e === 45 ? f(e) : d(e);
	}
	function m(t) {
		return t === "CDATA[".charCodeAt(a++) ? (e.consume(t), a === 6 ? h : m) : n(t);
	}
	function h(t) {
		return t === null ? n(t) : t === 93 ? (e.consume(t), g) : Z(t) ? (o = h, ne(t)) : (e.consume(t), h);
	}
	function g(t) {
		return t === 93 ? (e.consume(t), _) : h(t);
	}
	function _(t) {
		return t === 62 ? te(t) : t === 93 ? (e.consume(t), _) : h(t);
	}
	function v(t) {
		return t === null || t === 62 ? te(t) : Z(t) ? (o = v, ne(t)) : (e.consume(t), v);
	}
	function y(t) {
		return t === null ? n(t) : t === 63 ? (e.consume(t), b) : Z(t) ? (o = y, ne(t)) : (e.consume(t), y);
	}
	function b(e) {
		return e === 62 ? te(e) : y(e);
	}
	function x(t) {
		return hg(t) ? (e.consume(t), S) : n(t);
	}
	function S(t) {
		return t === 45 || gg(t) ? (e.consume(t), S) : C(t);
	}
	function C(t) {
		return Z(t) ? (o = C, ne(t)) : Q(t) ? (e.consume(t), C) : te(t);
	}
	function w(t) {
		return t === 45 || gg(t) ? (e.consume(t), w) : t === 47 || t === 62 || Sg(t) ? T(t) : n(t);
	}
	function T(t) {
		return t === 47 ? (e.consume(t), te) : t === 58 || t === 95 || hg(t) ? (e.consume(t), E) : Z(t) ? (o = T, ne(t)) : Q(t) ? (e.consume(t), T) : te(t);
	}
	function E(t) {
		return t === 45 || t === 46 || t === 58 || t === 95 || gg(t) ? (e.consume(t), E) : D(t);
	}
	function D(t) {
		return t === 61 ? (e.consume(t), O) : Z(t) ? (o = D, ne(t)) : Q(t) ? (e.consume(t), D) : T(t);
	}
	function O(t) {
		return t === null || t === 60 || t === 61 || t === 62 || t === 96 ? n(t) : t === 34 || t === 39 ? (e.consume(t), i = t, k) : Z(t) ? (o = O, ne(t)) : Q(t) ? (e.consume(t), O) : (e.consume(t), ee);
	}
	function k(t) {
		return t === i ? (e.consume(t), i = void 0, A) : t === null ? n(t) : Z(t) ? (o = k, ne(t)) : (e.consume(t), k);
	}
	function ee(t) {
		return t === null || t === 34 || t === 39 || t === 60 || t === 61 || t === 96 ? n(t) : t === 47 || t === 62 || Sg(t) ? T(t) : (e.consume(t), ee);
	}
	function A(e) {
		return e === 47 || e === 62 || Sg(e) ? T(e) : n(e);
	}
	function te(r) {
		return r === 62 ? (e.consume(r), e.exit("htmlTextData"), e.exit("htmlText"), t) : n(r);
	}
	function ne(t) {
		return e.exit("htmlTextData"), e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), j;
	}
	function j(t) {
		return Q(t) ? $(e, M, "linePrefix", r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(t) : M(t);
	}
	function M(t) {
		return e.enter("htmlTextData"), o(t);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/label-end.js
var H_ = {
	name: "labelEnd",
	resolveAll: K_,
	resolveTo: q_,
	tokenize: J_
}, U_ = { tokenize: Y_ }, W_ = { tokenize: X_ }, G_ = { tokenize: Z_ };
function K_(e) {
	let t = -1, n = [];
	for (; ++t < e.length;) {
		let r = e[t][1];
		if (n.push(e[t]), r.type === "labelImage" || r.type === "labelLink" || r.type === "labelEnd") {
			let e = r.type === "labelImage" ? 4 : 2;
			r.type = "data", t += e;
		}
	}
	return e.length !== n.length && sg(e, 0, e.length, n), e;
}
function q_(e, t) {
	let n = e.length, r = 0, i, a, o, s;
	for (; n--;) if (i = e[n][1], a) {
		if (i.type === "link" || i.type === "labelLink" && i._inactive) break;
		e[n][0] === "enter" && i.type === "labelLink" && (i._inactive = !0);
	} else if (o) {
		if (e[n][0] === "enter" && (i.type === "labelImage" || i.type === "labelLink") && !i._balanced && (a = n, i.type !== "labelLink")) {
			r = 2;
			break;
		}
	} else i.type === "labelEnd" && (o = n);
	let c = {
		type: e[a][1].type === "labelLink" ? "link" : "image",
		start: { ...e[a][1].start },
		end: { ...e[e.length - 1][1].end }
	}, l = {
		type: "label",
		start: { ...e[a][1].start },
		end: { ...e[o][1].end }
	}, u = {
		type: "labelText",
		start: { ...e[a + r + 2][1].end },
		end: { ...e[o - 2][1].start }
	};
	return s = [[
		"enter",
		c,
		t
	], [
		"enter",
		l,
		t
	]], s = cg(s, e.slice(a + 1, a + r + 3)), s = cg(s, [[
		"enter",
		u,
		t
	]]), s = cg(s, Pg(t.parser.constructs.insideSpan.null, e.slice(a + r + 4, o - 3), t)), s = cg(s, [
		[
			"exit",
			u,
			t
		],
		e[o - 2],
		e[o - 1],
		[
			"exit",
			l,
			t
		]
	]), s = cg(s, e.slice(o + 1)), s = cg(s, [[
		"exit",
		c,
		t
	]]), sg(e, a, e.length, s), e;
}
function J_(e, t, n) {
	let r = this, i = r.events.length, a, o;
	for (; i--;) if ((r.events[i][1].type === "labelImage" || r.events[i][1].type === "labelLink") && !r.events[i][1]._balanced) {
		a = r.events[i][1];
		break;
	}
	return s;
	function s(t) {
		return a ? a._inactive ? d(t) : (o = r.parser.defined.includes(mg(r.sliceSerialize({
			start: a.end,
			end: r.now()
		}))), e.enter("labelEnd"), e.enter("labelMarker"), e.consume(t), e.exit("labelMarker"), e.exit("labelEnd"), c) : n(t);
	}
	function c(t) {
		return t === 40 ? e.attempt(U_, u, o ? u : d)(t) : t === 91 ? e.attempt(W_, u, o ? l : d)(t) : o ? u(t) : d(t);
	}
	function l(t) {
		return e.attempt(G_, u, d)(t);
	}
	function u(e) {
		return t(e);
	}
	function d(e) {
		return a._balanced = !0, n(e);
	}
}
function Y_(e, t, n) {
	return r;
	function r(t) {
		return e.enter("resource"), e.enter("resourceMarker"), e.consume(t), e.exit("resourceMarker"), i;
	}
	function i(t) {
		return Sg(t) ? x_(e, a)(t) : a(t);
	}
	function a(t) {
		return t === 41 ? u(t) : v_(e, o, s, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(t);
	}
	function o(t) {
		return Sg(t) ? x_(e, c)(t) : u(t);
	}
	function s(e) {
		return n(e);
	}
	function c(t) {
		return t === 34 || t === 39 || t === 40 ? b_(e, l, n, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(t) : u(t);
	}
	function l(t) {
		return Sg(t) ? x_(e, u)(t) : u(t);
	}
	function u(r) {
		return r === 41 ? (e.enter("resourceMarker"), e.consume(r), e.exit("resourceMarker"), e.exit("resource"), t) : n(r);
	}
}
function X_(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return y_.call(r, e, a, o, "reference", "referenceMarker", "referenceString")(t);
	}
	function a(e) {
		return r.parser.defined.includes(mg(r.sliceSerialize(r.events[r.events.length - 1][1]).slice(1, -1))) ? t(e) : n(e);
	}
	function o(e) {
		return n(e);
	}
}
function Z_(e, t, n) {
	return r;
	function r(t) {
		return e.enter("reference"), e.enter("referenceMarker"), e.consume(t), e.exit("referenceMarker"), i;
	}
	function i(r) {
		return r === 93 ? (e.enter("referenceMarker"), e.consume(r), e.exit("referenceMarker"), e.exit("reference"), t) : n(r);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/label-start-image.js
var Q_ = {
	name: "labelStartImage",
	resolveAll: H_.resolveAll,
	tokenize: $_
};
function $_(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return e.enter("labelImage"), e.enter("labelImageMarker"), e.consume(t), e.exit("labelImageMarker"), a;
	}
	function a(t) {
		return t === 91 ? (e.enter("labelMarker"), e.consume(t), e.exit("labelMarker"), e.exit("labelImage"), o) : n(t);
	}
	function o(e) {
		/* c8 ignore next 3 */
		return e === 94 && "_hiddenFootnoteSupport" in r.parser.constructs ? n(e) : t(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/label-start-link.js
var ev = {
	name: "labelStartLink",
	resolveAll: H_.resolveAll,
	tokenize: tv
};
function tv(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return e.enter("labelLink"), e.enter("labelMarker"), e.consume(t), e.exit("labelMarker"), e.exit("labelLink"), a;
	}
	function a(e) {
		/* c8 ignore next 3 */
		return e === 94 && "_hiddenFootnoteSupport" in r.parser.constructs ? n(e) : t(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/line-ending.js
var nv = {
	name: "lineEnding",
	tokenize: rv
};
function rv(e, t) {
	return n;
	function n(n) {
		return e.enter("lineEnding"), e.consume(n), e.exit("lineEnding"), $(e, t, "linePrefix");
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/thematic-break.js
var iv = {
	name: "thematicBreak",
	tokenize: av
};
function av(e, t, n) {
	let r = 0, i;
	return a;
	function a(t) {
		return e.enter("thematicBreak"), o(t);
	}
	function o(e) {
		return i = e, s(e);
	}
	function s(a) {
		return a === i ? (e.enter("thematicBreakSequence"), c(a)) : r >= 3 && (a === null || Z(a)) ? (e.exit("thematicBreak"), t(a)) : n(a);
	}
	function c(t) {
		return t === i ? (e.consume(t), r++, c) : (e.exit("thematicBreakSequence"), Q(t) ? $(e, s, "whitespace")(t) : s(t));
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/list.js
var ov = {
	continuation: { tokenize: uv },
	exit: fv,
	name: "list",
	tokenize: lv
}, sv = {
	partial: !0,
	tokenize: pv
}, cv = {
	partial: !0,
	tokenize: dv
};
function lv(e, t, n) {
	let r = this, i = r.events[r.events.length - 1], a = i && i[1].type === "linePrefix" ? i[2].sliceSerialize(i[1], !0).length : 0, o = 0;
	return s;
	function s(t) {
		let i = r.containerState.type || (t === 42 || t === 43 || t === 45 ? "listUnordered" : "listOrdered");
		if (i === "listUnordered" ? !r.containerState.marker || t === r.containerState.marker : yg(t)) {
			if (r.containerState.type || (r.containerState.type = i, e.enter(i, { _container: !0 })), i === "listUnordered") return e.enter("listItemPrefix"), t === 42 || t === 45 ? e.check(iv, n, l)(t) : l(t);
			if (!r.interrupt || t === 49) return e.enter("listItemPrefix"), e.enter("listItemValue"), c(t);
		}
		return n(t);
	}
	function c(t) {
		return yg(t) && ++o < 10 ? (e.consume(t), c) : (!r.interrupt || o < 2) && (r.containerState.marker ? t === r.containerState.marker : t === 41 || t === 46) ? (e.exit("listItemValue"), l(t)) : n(t);
	}
	function l(t) {
		return e.enter("listItemMarker"), e.consume(t), e.exit("listItemMarker"), r.containerState.marker = r.containerState.marker || t, e.check(Vg, r.interrupt ? n : u, e.attempt(sv, f, d));
	}
	function u(e) {
		return r.containerState.initialBlankLine = !0, a++, f(e);
	}
	function d(t) {
		return Q(t) ? (e.enter("listItemPrefixWhitespace"), e.consume(t), e.exit("listItemPrefixWhitespace"), f) : n(t);
	}
	function f(n) {
		return r.containerState.size = a + r.sliceSerialize(e.exit("listItemPrefix"), !0).length, t(n);
	}
}
function uv(e, t, n) {
	let r = this;
	return r.containerState._closeFlow = void 0, e.check(Vg, i, a);
	function i(n) {
		return r.containerState.furtherBlankLines = r.containerState.furtherBlankLines || r.containerState.initialBlankLine, $(e, t, "listItemIndent", r.containerState.size + 1)(n);
	}
	function a(n) {
		return r.containerState.furtherBlankLines || !Q(n) ? (r.containerState.furtherBlankLines = void 0, r.containerState.initialBlankLine = void 0, o(n)) : (r.containerState.furtherBlankLines = void 0, r.containerState.initialBlankLine = void 0, e.attempt(cv, t, o)(n));
	}
	function o(i) {
		return r.containerState._closeFlow = !0, r.interrupt = void 0, $(e, e.attempt(ov, t, n), "linePrefix", r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(i);
	}
}
function dv(e, t, n) {
	let r = this;
	return $(e, i, "listItemIndent", r.containerState.size + 1);
	function i(e) {
		let i = r.events[r.events.length - 1];
		return i && i[1].type === "listItemIndent" && i[2].sliceSerialize(i[1], !0).length === r.containerState.size ? t(e) : n(e);
	}
}
function fv(e) {
	e.exit(this.containerState.type);
}
function pv(e, t, n) {
	let r = this;
	return $(e, i, "listItemPrefixWhitespace", r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 5);
	function i(e) {
		let i = r.events[r.events.length - 1];
		return !Q(e) && i && i[1].type === "listItemPrefixWhitespace" ? t(e) : n(e);
	}
}
//#endregion
//#region node_modules/micromark-core-commonmark/lib/setext-underline.js
var mv = {
	name: "setextUnderline",
	resolveTo: hv,
	tokenize: gv
};
function hv(e, t) {
	let n = e.length, r, i, a;
	for (; n--;) if (e[n][0] === "enter") {
		if (e[n][1].type === "content") {
			r = n;
			break;
		}
		e[n][1].type === "paragraph" && (i = n);
	} else e[n][1].type === "content" && e.splice(n, 1), !a && e[n][1].type === "definition" && (a = n);
	let o = {
		type: "setextHeading",
		start: { ...e[r][1].start },
		end: { ...e[e.length - 1][1].end }
	};
	return e[i][1].type = "setextHeadingText", a ? (e.splice(i, 0, [
		"enter",
		o,
		t
	]), e.splice(a + 1, 0, [
		"exit",
		e[r][1],
		t
	]), e[r][1].end = { ...e[a][1].end }) : e[r][1] = o, e.push([
		"exit",
		o,
		t
	]), e;
}
function gv(e, t, n) {
	let r = this, i;
	return a;
	function a(t) {
		let a = r.events.length, s;
		for (; a--;) if (r.events[a][1].type !== "lineEnding" && r.events[a][1].type !== "linePrefix" && r.events[a][1].type !== "content") {
			s = r.events[a][1].type === "paragraph";
			break;
		}
		return !r.parser.lazy[r.now().line] && (r.interrupt || s) ? (e.enter("setextHeadingLine"), i = t, o(t)) : n(t);
	}
	function o(t) {
		return e.enter("setextHeadingLineSequence"), s(t);
	}
	function s(t) {
		return t === i ? (e.consume(t), s) : (e.exit("setextHeadingLineSequence"), Q(t) ? $(e, c, "lineSuffix")(t) : c(t));
	}
	function c(r) {
		return r === null || Z(r) ? (e.exit("setextHeadingLine"), t(r)) : n(r);
	}
}
//#endregion
//#region node_modules/micromark/lib/initialize/flow.js
var _v = { tokenize: vv };
function vv(e) {
	let t = this, n = e.attempt(Vg, r, e.attempt(this.parser.constructs.flowInitial, i, $(e, e.attempt(this.parser.constructs.flow, i, e.attempt(p_, i)), "linePrefix")));
	return n;
	function r(r) {
		if (r === null) {
			e.consume(r);
			return;
		}
		return e.enter("lineEndingBlank"), e.consume(r), e.exit("lineEndingBlank"), t.currentConstruct = void 0, n;
	}
	function i(r) {
		if (r === null) {
			e.consume(r);
			return;
		}
		return e.enter("lineEnding"), e.consume(r), e.exit("lineEnding"), t.currentConstruct = void 0, n;
	}
}
//#endregion
//#region node_modules/micromark/lib/initialize/text.js
var yv = { resolveAll: Cv() }, bv = Sv("string"), xv = Sv("text");
function Sv(e) {
	return {
		resolveAll: Cv(e === "text" ? wv : void 0),
		tokenize: t
	};
	function t(t) {
		let n = this, r = this.parser.constructs[e], i = t.attempt(r, a, o);
		return a;
		function a(e) {
			return c(e) ? i(e) : o(e);
		}
		function o(e) {
			if (e === null) {
				t.consume(e);
				return;
			}
			return t.enter("data"), t.consume(e), s;
		}
		function s(e) {
			return c(e) ? (t.exit("data"), i(e)) : (t.consume(e), s);
		}
		function c(e) {
			if (e === null) return !0;
			let t = r[e], i = -1;
			if (t) for (; ++i < t.length;) {
				let e = t[i];
				if (!e.previous || e.previous.call(n, n.previous)) return !0;
			}
			return !1;
		}
	}
}
function Cv(e) {
	return t;
	function t(t, n) {
		let r = -1, i;
		for (; ++r <= t.length;) i === void 0 ? t[r] && t[r][1].type === "data" && (i = r, r++) : (!t[r] || t[r][1].type !== "data") && (r !== i + 2 && (t[i][1].end = t[r - 1][1].end, t.splice(i + 2, r - i - 2), r = i + 2), i = void 0);
		return e ? e(t, n) : t;
	}
}
function wv(e, t) {
	let n = 0;
	for (; ++n <= e.length;) if ((n === e.length || e[n][1].type === "lineEnding") && e[n - 1][1].type === "data") {
		let r = e[n - 1][1], i = t.sliceStream(r), a = i.length, o = -1, s = 0, c;
		for (; a--;) {
			let e = i[a];
			if (typeof e == "string") {
				for (o = e.length; e.charCodeAt(o - 1) === 32;) s++, o--;
				if (o) break;
				o = -1;
			} else if (e === -2) c = !0, s++;
			else if (e !== -1) {
				a++;
				break;
			}
		}
		if (t._contentTypeTextTrailing && n === e.length && (s = 0), s) {
			let i = {
				type: n === e.length || c || s < 2 ? "lineSuffix" : "hardBreakTrailing",
				start: {
					_bufferIndex: a ? o : r.start._bufferIndex + o,
					_index: r.start._index + a,
					line: r.end.line,
					column: r.end.column - s,
					offset: r.end.offset - s
				},
				end: { ...r.end }
			};
			r.end = { ...i.start }, r.start.offset === r.end.offset ? Object.assign(r, i) : (e.splice(n, 0, [
				"enter",
				i,
				t
			], [
				"exit",
				i,
				t
			]), n += 2);
		}
		n++;
	}
	return e;
}
//#endregion
//#region node_modules/micromark/lib/constructs.js
var Tv = /* @__PURE__ */ s({
	attentionMarkers: () => Nv,
	contentInitial: () => Dv,
	disable: () => Pv,
	document: () => Ev,
	flow: () => kv,
	flowInitial: () => Ov,
	insideSpan: () => Mv,
	string: () => Av,
	text: () => jv
}), Ev = {
	42: ov,
	43: ov,
	45: ov,
	48: ov,
	49: ov,
	50: ov,
	51: ov,
	52: ov,
	53: ov,
	54: ov,
	55: ov,
	56: ov,
	57: ov,
	62: Ug
}, Dv = { 91: S_ }, Ov = {
	[-2]: t_,
	[-1]: t_,
	32: t_
}, kv = {
	35: O_,
	42: iv,
	45: [mv, iv],
	60: N_,
	61: mv,
	95: iv,
	96: Qg,
	126: Qg
}, Av = {
	38: Yg,
	92: qg
}, jv = {
	[-5]: nv,
	[-4]: nv,
	[-3]: nv,
	33: Q_,
	38: Yg,
	42: Fg,
	60: [zg, B_],
	91: ev,
	92: [E_, qg],
	93: H_,
	95: Fg,
	96: a_
}, Mv = { null: [Fg, yv] }, Nv = { null: [42, 95] }, Pv = { null: [] };
//#endregion
//#region node_modules/micromark/lib/create-tokenizer.js
function Fv(e, t, n) {
	let r = {
		_bufferIndex: -1,
		_index: 0,
		line: n && n.line || 1,
		column: n && n.column || 1,
		offset: n && n.offset || 0
	}, i = {}, a = [], o = [], s = [], c = {
		attempt: C(x),
		check: C(S),
		consume: v,
		enter: y,
		exit: b,
		interrupt: C(S, { interrupt: !0 })
	}, l = {
		code: null,
		containerState: {},
		defineSkip: h,
		events: [],
		now: m,
		parser: e,
		previous: null,
		sliceSerialize: f,
		sliceStream: p,
		write: d
	}, u = t.tokenize.call(l, c);
	return t.resolveAll && a.push(t), l;
	function d(e) {
		return o = cg(o, e), g(), o[o.length - 1] === null ? (w(t, 0), l.events = Pg(a, l.events, l), l.events) : [];
	}
	function f(e, t) {
		return Lv(p(e), t);
	}
	function p(e) {
		return Iv(o, e);
	}
	function m() {
		let { _bufferIndex: e, _index: t, line: n, column: i, offset: a } = r;
		return {
			_bufferIndex: e,
			_index: t,
			line: n,
			column: i,
			offset: a
		};
	}
	function h(e) {
		i[e.line] = e.column, E();
	}
	function g() {
		let e;
		for (; r._index < o.length;) {
			let t = o[r._index];
			if (typeof t == "string") for (e = r._index, r._bufferIndex < 0 && (r._bufferIndex = 0); r._index === e && r._bufferIndex < t.length;) _(t.charCodeAt(r._bufferIndex));
			else _(t);
		}
	}
	function _(e) {
		u = u(e);
	}
	function v(e) {
		Z(e) ? (r.line++, r.column = 1, r.offset += e === -3 ? 2 : 1, E()) : e !== -1 && (r.column++, r.offset++), r._bufferIndex < 0 ? r._index++ : (r._bufferIndex++, r._bufferIndex === o[r._index].length && (r._bufferIndex = -1, r._index++)), l.previous = e;
	}
	function y(e, t) {
		let n = t || {};
		return n.type = e, n.start = m(), l.events.push([
			"enter",
			n,
			l
		]), s.push(n), n;
	}
	function b(e) {
		let t = s.pop();
		return t.end = m(), l.events.push([
			"exit",
			t,
			l
		]), t;
	}
	function x(e, t) {
		w(e, t.from);
	}
	function S(e, t) {
		t.restore();
	}
	function C(e, t) {
		return n;
		function n(n, r, i) {
			let a, o, s, u;
			return Array.isArray(n) ? f(n) : "tokenize" in n ? f([n]) : d(n);
			function d(e) {
				return t;
				function t(t) {
					let n = t !== null && e[t], r = t !== null && e.null;
					return f([...Array.isArray(n) ? n : n ? [n] : [], ...Array.isArray(r) ? r : r ? [r] : []])(t);
				}
			}
			function f(e) {
				return a = e, o = 0, e.length === 0 ? i : p(e[o]);
			}
			function p(e) {
				return n;
				function n(n) {
					return u = T(), s = e, e.partial || (l.currentConstruct = e), e.name && l.parser.constructs.disable.null.includes(e.name) ? h(n) : e.tokenize.call(t ? Object.assign(Object.create(l), t) : l, c, m, h)(n);
				}
			}
			function m(t) {
				return e(s, u), r;
			}
			function h(e) {
				return u.restore(), ++o < a.length ? p(a[o]) : i;
			}
		}
	}
	function w(e, t) {
		e.resolveAll && !a.includes(e) && a.push(e), e.resolve && sg(l.events, t, l.events.length - t, e.resolve(l.events.slice(t), l)), e.resolveTo && (l.events = e.resolveTo(l.events, l));
	}
	function T() {
		let e = m(), t = l.previous, n = l.currentConstruct, i = l.events.length, a = Array.from(s);
		return {
			from: i,
			restore: o
		};
		function o() {
			r = e, l.previous = t, l.currentConstruct = n, l.events.length = i, s = a, E();
		}
	}
	function E() {
		r.line in i && r.column < 2 && (r.column = i[r.line], r.offset += i[r.line] - 1);
	}
}
function Iv(e, t) {
	let n = t.start._index, r = t.start._bufferIndex, i = t.end._index, a = t.end._bufferIndex, o;
	if (n === i) o = [e[n].slice(r, a)];
	else {
		if (o = e.slice(n, i), r > -1) {
			let e = o[0];
			typeof e == "string" ? o[0] = e.slice(r) : o.shift();
		}
		a > 0 && o.push(e[i].slice(0, a));
	}
	return o;
}
function Lv(e, t) {
	let n = -1, r = [], i;
	for (; ++n < e.length;) {
		let a = e[n], o;
		if (typeof a == "string") o = a;
		else switch (a) {
			case -5:
				o = "\r";
				break;
			case -4:
				o = "\n";
				break;
			case -3:
				o = "\r\n";
				break;
			case -2:
				o = t ? " " : "	";
				break;
			case -1:
				if (!t && i) continue;
				o = " ";
				break;
			default: o = String.fromCharCode(a);
		}
		i = a === -2, r.push(o);
	}
	return r.join("");
}
//#endregion
//#region node_modules/micromark/lib/parse.js
function Rv(e) {
	let t = {
		constructs: ug([Tv, ...(e || {}).extensions || []]),
		content: n(Dg),
		defined: [],
		document: n(kg),
		flow: n(_v),
		lazy: {},
		string: n(bv),
		text: n(xv)
	};
	return t;
	function n(e) {
		return n;
		function n(n) {
			return Fv(t, e, n);
		}
	}
}
//#endregion
//#region node_modules/micromark/lib/postprocess.js
function zv(e) {
	for (; !d_(e););
	return e;
}
//#endregion
//#region node_modules/micromark/lib/preprocess.js
var Bv = /[\0\t\n\r]/g;
function Vv() {
	let e = 1, t = "", n = !0, r;
	return i;
	function i(i, a, o) {
		let s = [], c, l, u, d, f;
		for (i = t + (typeof i == "string" ? i.toString() : new TextDecoder(a || void 0).decode(i)), u = 0, t = "", n &&= (i.charCodeAt(0) === 65279 && u++, void 0); u < i.length;) {
			if (Bv.lastIndex = u, c = Bv.exec(i), d = c && c.index !== void 0 ? c.index : i.length, f = i.charCodeAt(d), !c) {
				t = i.slice(u);
				break;
			}
			if (f === 10 && u === d && r) s.push(-3), r = void 0;
			else switch (r &&= (s.push(-5), void 0), u < d && (s.push(i.slice(u, d)), e += d - u), f) {
				case 0:
					s.push(65533), e++;
					break;
				case 9:
					for (l = Math.ceil(e / 4) * 4, s.push(-2); e++ < l;) s.push(-1);
					break;
				case 10:
					s.push(-4), e = 1;
					break;
				default: r = !0, e = 1;
			}
			u = d + 1;
		}
		return o && (r && s.push(-5), t && s.push(t), s.push(null)), s;
	}
}
//#endregion
//#region node_modules/micromark-util-decode-string/index.js
var Hv = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function Uv(e) {
	return e.replace(Hv, Wv);
}
function Wv(e, t, n) {
	if (t) return t;
	if (n.charCodeAt(0) === 35) {
		let e = n.charCodeAt(1), t = e === 120 || e === 88;
		return pg(n.slice(t ? 2 : 1), t ? 16 : 10);
	}
	return og(n) || e;
}
//#endregion
//#region node_modules/mdast-util-from-markdown/lib/index.js
var Gv = {}.hasOwnProperty;
function Kv(e, t, n) {
	return t && typeof t == "object" && (n = t, t = void 0), qv(n)(zv(Rv(n).document().write(Vv()(e, t, !0))));
}
function qv(e) {
	let t = {
		transforms: [],
		canContainEols: [
			"emphasis",
			"fragment",
			"heading",
			"paragraph",
			"strong"
		],
		enter: {
			autolink: a(ve),
			autolinkProtocol: T,
			autolinkEmail: T,
			atxHeading: a(F),
			blockQuote: a(de),
			characterEscape: T,
			characterReference: T,
			codeFenced: a(fe),
			codeFencedFenceInfo: o,
			codeFencedFenceMeta: o,
			codeIndented: a(fe, o),
			codeText: a(pe, o),
			codeTextData: T,
			data: T,
			codeFlowValue: T,
			definition: a(me),
			definitionDestinationString: o,
			definitionLabelString: o,
			definitionTitleString: o,
			emphasis: a(he),
			hardBreakEscape: a(I),
			hardBreakTrailing: a(I),
			htmlFlow: a(ge, o),
			htmlFlowData: T,
			htmlText: a(ge, o),
			htmlTextData: T,
			image: a(_e),
			label: o,
			link: a(ve),
			listItem: a(be),
			listItemValue: f,
			listOrdered: a(ye, d),
			listUnordered: a(ye),
			paragraph: a(xe),
			reference: ie,
			referenceString: o,
			resourceDestinationString: o,
			resourceTitleString: o,
			setextHeading: a(F),
			strong: a(Se),
			thematicBreak: a(we)
		},
		exit: {
			atxHeading: c(),
			atxHeadingSequence: x,
			autolink: c(),
			autolinkEmail: ue,
			autolinkProtocol: le,
			blockQuote: c(),
			characterEscapeValue: E,
			characterReferenceMarkerHexadecimal: oe,
			characterReferenceMarkerNumeric: oe,
			characterReferenceValue: se,
			characterReference: ce,
			codeFenced: c(g),
			codeFencedFence: h,
			codeFencedFenceInfo: p,
			codeFencedFenceMeta: m,
			codeFlowValue: E,
			codeIndented: c(_),
			codeText: c(A),
			codeTextData: E,
			data: E,
			definition: c(),
			definitionDestinationString: b,
			definitionLabelString: v,
			definitionTitleString: y,
			emphasis: c(),
			hardBreakEscape: c(O),
			hardBreakTrailing: c(O),
			htmlFlow: c(k),
			htmlFlowData: E,
			htmlText: c(ee),
			htmlTextData: E,
			image: c(ne),
			label: M,
			labelText: j,
			lineEnding: D,
			link: c(te),
			listItem: c(),
			listOrdered: c(),
			listUnordered: c(),
			paragraph: c(),
			referenceString: ae,
			resourceDestinationString: re,
			resourceTitleString: N,
			resource: P,
			setextHeading: c(w),
			setextHeadingLineSequence: C,
			setextHeadingText: S,
			strong: c(),
			thematicBreak: c()
		}
	};
	Yv(t, (e || {}).mdastExtensions || []);
	let n = {};
	return r;
	function r(e) {
		let r = {
			type: "root",
			children: []
		}, a = {
			stack: [r],
			tokenStack: [],
			config: t,
			enter: s,
			exit: l,
			buffer: o,
			resume: u,
			data: n
		}, c = [], d = -1;
		for (; ++d < e.length;) (e[d][1].type === "listOrdered" || e[d][1].type === "listUnordered") && (e[d][0] === "enter" ? c.push(d) : d = i(e, c.pop(), d));
		for (d = -1; ++d < e.length;) {
			let n = t[e[d][0]];
			Gv.call(n, e[d][1].type) && n[e[d][1].type].call(Object.assign({ sliceSerialize: e[d][2].sliceSerialize }, a), e[d][1]);
		}
		if (a.tokenStack.length > 0) {
			let e = a.tokenStack[a.tokenStack.length - 1];
			(e[1] || Zv).call(a, void 0, e[0]);
		}
		for (r.position = {
			start: Jv(e.length > 0 ? e[0][1].start : {
				line: 1,
				column: 1,
				offset: 0
			}),
			end: Jv(e.length > 0 ? e[e.length - 2][1].end : {
				line: 1,
				column: 1,
				offset: 0
			})
		}, d = -1; ++d < t.transforms.length;) r = t.transforms[d](r) || r;
		return r;
	}
	function i(e, t, n) {
		let r = t - 1, i = -1, a = !1, o, s, c, l;
		for (; ++r <= n;) {
			let t = e[r];
			switch (t[1].type) {
				case "listUnordered":
				case "listOrdered":
				case "blockQuote":
					t[0] === "enter" ? i++ : i--, l = void 0;
					break;
				case "lineEndingBlank":
					t[0] === "enter" && (o && !l && !i && !c && (c = r), l = void 0);
					break;
				case "linePrefix":
				case "listItemValue":
				case "listItemMarker":
				case "listItemPrefix":
				case "listItemPrefixWhitespace": break;
				default: l = void 0;
			}
			if (!i && t[0] === "enter" && t[1].type === "listItemPrefix" || i === -1 && t[0] === "exit" && (t[1].type === "listUnordered" || t[1].type === "listOrdered")) {
				if (o) {
					let i = r;
					for (s = void 0; i--;) {
						let t = e[i];
						if (t[1].type === "lineEnding" || t[1].type === "lineEndingBlank") {
							if (t[0] === "exit") continue;
							s && (e[s][1].type = "lineEndingBlank", a = !0), t[1].type = "lineEnding", s = i;
						} else if (t[1].type !== "linePrefix" && t[1].type !== "blockQuotePrefix" && t[1].type !== "blockQuotePrefixWhitespace" && t[1].type !== "blockQuoteMarker" && t[1].type !== "listItemIndent") break;
					}
					c && (!s || c < s) && (o._spread = !0), o.end = Object.assign({}, s ? e[s][1].start : t[1].end), e.splice(s || r, 0, [
						"exit",
						o,
						t[2]
					]), r++, n++;
				}
				if (t[1].type === "listItemPrefix") {
					let i = {
						type: "listItem",
						_spread: !1,
						start: Object.assign({}, t[1].start),
						end: void 0
					};
					o = i, e.splice(r, 0, [
						"enter",
						i,
						t[2]
					]), r++, n++, c = void 0, l = !0;
				}
			}
		}
		return e[t][1]._spread = a, n;
	}
	function a(e, t) {
		return n;
		function n(n) {
			s.call(this, e(n), n), t && t.call(this, n);
		}
	}
	function o() {
		this.stack.push({
			type: "fragment",
			children: []
		});
	}
	function s(e, t, n) {
		this.stack[this.stack.length - 1].children.push(e), this.stack.push(e), this.tokenStack.push([t, n || void 0]), e.position = {
			start: Jv(t.start),
			end: void 0
		};
	}
	function c(e) {
		return t;
		function t(t) {
			e && e.call(this, t), l.call(this, t);
		}
	}
	function l(e, t) {
		let n = this.stack.pop(), r = this.tokenStack.pop();
		if (r) r[0].type !== e.type && (t ? t.call(this, e, r[0]) : (r[1] || Zv).call(this, e, r[0]));
		else throw Error("Cannot close `" + e.type + "` (" + yh({
			start: e.start,
			end: e.end
		}) + "): it’s not open");
		n.position.end = Jv(e.end);
	}
	function u() {
		return tg(this.stack.pop());
	}
	function d() {
		this.data.expectingFirstListItemValue = !0;
	}
	function f(e) {
		if (this.data.expectingFirstListItemValue) {
			let t = this.stack[this.stack.length - 2];
			t.start = Number.parseInt(this.sliceSerialize(e), 10), this.data.expectingFirstListItemValue = void 0;
		}
	}
	function p() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.lang = e;
	}
	function m() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.meta = e;
	}
	function h() {
		this.data.flowCodeInside || (this.buffer(), this.data.flowCodeInside = !0);
	}
	function g() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.value = e.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, ""), this.data.flowCodeInside = void 0;
	}
	function _() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.value = e.replace(/(\r?\n|\r)$/g, "");
	}
	function v(e) {
		let t = this.resume(), n = this.stack[this.stack.length - 1];
		n.label = t, n.identifier = mg(this.sliceSerialize(e)).toLowerCase();
	}
	function y() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.title = e;
	}
	function b() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.url = e;
	}
	function x(e) {
		let t = this.stack[this.stack.length - 1];
		t.depth ||= this.sliceSerialize(e).length;
	}
	function S() {
		this.data.setextHeadingSlurpLineEnding = !0;
	}
	function C(e) {
		let t = this.stack[this.stack.length - 1];
		t.depth = this.sliceSerialize(e).codePointAt(0) === 61 ? 1 : 2;
	}
	function w() {
		this.data.setextHeadingSlurpLineEnding = void 0;
	}
	function T(e) {
		let t = this.stack[this.stack.length - 1].children, n = t[t.length - 1];
		(!n || n.type !== "text") && (n = Ce(), n.position = {
			start: Jv(e.start),
			end: void 0
		}, t.push(n)), this.stack.push(n);
	}
	function E(e) {
		let t = this.stack.pop();
		t.value += this.sliceSerialize(e), t.position.end = Jv(e.end);
	}
	function D(e) {
		let n = this.stack[this.stack.length - 1];
		if (this.data.atHardBreak) {
			let t = n.children[n.children.length - 1];
			t.position.end = Jv(e.end), this.data.atHardBreak = void 0;
			return;
		}
		!this.data.setextHeadingSlurpLineEnding && t.canContainEols.includes(n.type) && (T.call(this, e), E.call(this, e));
	}
	function O() {
		this.data.atHardBreak = !0;
	}
	function k() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.value = e;
	}
	function ee() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.value = e;
	}
	function A() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.value = e;
	}
	function te() {
		let e = this.stack[this.stack.length - 1];
		if (this.data.inReference) {
			let t = this.data.referenceType || "shortcut";
			e.type += "Reference", e.referenceType = t, delete e.url, delete e.title;
		} else delete e.identifier, delete e.label;
		this.data.referenceType = void 0;
	}
	function ne() {
		let e = this.stack[this.stack.length - 1];
		if (this.data.inReference) {
			let t = this.data.referenceType || "shortcut";
			e.type += "Reference", e.referenceType = t, delete e.url, delete e.title;
		} else delete e.identifier, delete e.label;
		this.data.referenceType = void 0;
	}
	function j(e) {
		let t = this.sliceSerialize(e), n = this.stack[this.stack.length - 2];
		n.label = Uv(t), n.identifier = mg(t).toLowerCase();
	}
	function M() {
		let e = this.stack[this.stack.length - 1], t = this.resume(), n = this.stack[this.stack.length - 1];
		this.data.inReference = !0, n.type === "link" ? n.children = e.children : n.alt = t;
	}
	function re() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.url = e;
	}
	function N() {
		let e = this.resume(), t = this.stack[this.stack.length - 1];
		t.title = e;
	}
	function P() {
		this.data.inReference = void 0;
	}
	function ie() {
		this.data.referenceType = "collapsed";
	}
	function ae(e) {
		let t = this.resume(), n = this.stack[this.stack.length - 1];
		n.label = t, n.identifier = mg(this.sliceSerialize(e)).toLowerCase(), this.data.referenceType = "full";
	}
	function oe(e) {
		this.data.characterReferenceType = e.type;
	}
	function se(e) {
		let t = this.sliceSerialize(e), n = this.data.characterReferenceType, r;
		n ? (r = pg(t, n === "characterReferenceMarkerNumeric" ? 10 : 16), this.data.characterReferenceType = void 0) : r = og(t);
		let i = this.stack[this.stack.length - 1];
		i.value += r;
	}
	function ce(e) {
		let t = this.stack.pop();
		t.position.end = Jv(e.end);
	}
	function le(e) {
		E.call(this, e);
		let t = this.stack[this.stack.length - 1];
		t.url = this.sliceSerialize(e);
	}
	function ue(e) {
		E.call(this, e);
		let t = this.stack[this.stack.length - 1];
		t.url = "mailto:" + this.sliceSerialize(e);
	}
	function de() {
		return {
			type: "blockquote",
			children: []
		};
	}
	function fe() {
		return {
			type: "code",
			lang: null,
			meta: null,
			value: ""
		};
	}
	function pe() {
		return {
			type: "inlineCode",
			value: ""
		};
	}
	function me() {
		return {
			type: "definition",
			identifier: "",
			label: null,
			title: null,
			url: ""
		};
	}
	function he() {
		return {
			type: "emphasis",
			children: []
		};
	}
	function F() {
		return {
			type: "heading",
			depth: 0,
			children: []
		};
	}
	function I() {
		return { type: "break" };
	}
	function ge() {
		return {
			type: "html",
			value: ""
		};
	}
	function _e() {
		return {
			type: "image",
			title: null,
			url: "",
			alt: null
		};
	}
	function ve() {
		return {
			type: "link",
			title: null,
			url: "",
			children: []
		};
	}
	function ye(e) {
		return {
			type: "list",
			ordered: e.type === "listOrdered",
			start: null,
			spread: e._spread,
			children: []
		};
	}
	function be(e) {
		return {
			type: "listItem",
			spread: e._spread,
			checked: null,
			children: []
		};
	}
	function xe() {
		return {
			type: "paragraph",
			children: []
		};
	}
	function Se() {
		return {
			type: "strong",
			children: []
		};
	}
	function Ce() {
		return {
			type: "text",
			value: ""
		};
	}
	function we() {
		return { type: "thematicBreak" };
	}
}
function Jv(e) {
	return {
		line: e.line,
		column: e.column,
		offset: e.offset
	};
}
function Yv(e, t) {
	let n = -1;
	for (; ++n < t.length;) {
		let r = t[n];
		Array.isArray(r) ? Yv(e, r) : Xv(e, r);
	}
}
function Xv(e, t) {
	let n;
	for (n in t) if (Gv.call(t, n)) switch (n) {
		case "canContainEols": {
			let r = t[n];
			r && e[n].push(...r);
			break;
		}
		case "transforms": {
			let r = t[n];
			r && e[n].push(...r);
			break;
		}
		case "enter":
		case "exit": {
			let r = t[n];
			r && Object.assign(e[n], r);
			break;
		}
	}
}
function Zv(e, t) {
	throw Error(e ? "Cannot close `" + e.type + "` (" + yh({
		start: e.start,
		end: e.end
	}) + "): a different token (`" + t.type + "`, " + yh({
		start: t.start,
		end: t.end
	}) + ") is open" : "Cannot close document, a token (`" + t.type + "`, " + yh({
		start: t.start,
		end: t.end
	}) + ") is still open");
}
//#endregion
//#region node_modules/remark-parse/lib/index.js
function Qv(e) {
	let t = this;
	t.parser = n;
	function n(n) {
		return Kv(n, {
			...t.data("settings"),
			...e,
			extensions: t.data("micromarkExtensions") || [],
			mdastExtensions: t.data("fromMarkdownExtensions") || []
		});
	}
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/blockquote.js
function $v(e, t) {
	let n = {
		type: "element",
		tagName: "blockquote",
		properties: {},
		children: e.wrap(e.all(t), !0)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/break.js
function ey(e, t) {
	let n = {
		type: "element",
		tagName: "br",
		properties: {},
		children: []
	};
	return e.patch(t, n), [e.applyData(t, n), {
		type: "text",
		value: "\n"
	}];
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/code.js
function ty(e, t) {
	let n = t.value ? t.value + "\n" : "", r = {}, i = t.lang ? t.lang.split(/\s+/) : [];
	i.length > 0 && (r.className = ["language-" + i[0]]);
	let a = {
		type: "element",
		tagName: "code",
		properties: r,
		children: [{
			type: "text",
			value: n
		}]
	};
	return t.meta && (a.data = { meta: t.meta }), e.patch(t, a), a = e.applyData(t, a), a = {
		type: "element",
		tagName: "pre",
		properties: {},
		children: [a]
	}, e.patch(t, a), a;
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/delete.js
function ny(e, t) {
	let n = {
		type: "element",
		tagName: "del",
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/emphasis.js
function ry(e, t) {
	let n = {
		type: "element",
		tagName: "em",
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/footnote-reference.js
function iy(e, t) {
	let n = typeof e.options.clobberPrefix == "string" ? e.options.clobberPrefix : "user-content-", r = String(t.identifier).toUpperCase(), i = Eg(r.toLowerCase()), a = e.footnoteOrder.indexOf(r), o, s = e.footnoteCounts.get(r);
	s === void 0 ? (s = 0, e.footnoteOrder.push(r), o = e.footnoteOrder.length) : o = a + 1, s += 1, e.footnoteCounts.set(r, s);
	let c = {
		type: "element",
		tagName: "a",
		properties: {
			href: "#" + n + "fn-" + i,
			id: n + "fnref-" + i + (s > 1 ? "-" + s : ""),
			dataFootnoteRef: !0,
			ariaDescribedBy: ["footnote-label"]
		},
		children: [{
			type: "text",
			value: String(o)
		}]
	};
	e.patch(t, c);
	let l = {
		type: "element",
		tagName: "sup",
		properties: {},
		children: [c]
	};
	return e.patch(t, l), e.applyData(t, l);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/heading.js
function ay(e, t) {
	let n = {
		type: "element",
		tagName: "h" + t.depth,
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/html.js
function oy(e, t) {
	if (e.options.allowDangerousHtml) {
		let n = {
			type: "raw",
			value: t.value
		};
		return e.patch(t, n), e.applyData(t, n);
	}
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/revert.js
function sy(e, t) {
	let n = t.referenceType, r = "]";
	if (n === "collapsed" ? r += "[]" : n === "full" && (r += "[" + (t.label || t.identifier) + "]"), t.type === "imageReference") return [{
		type: "text",
		value: "![" + t.alt + r
	}];
	let i = e.all(t), a = i[0];
	a && a.type === "text" ? a.value = "[" + a.value : i.unshift({
		type: "text",
		value: "["
	});
	let o = i[i.length - 1];
	return o && o.type === "text" ? o.value += r : i.push({
		type: "text",
		value: r
	}), i;
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/image-reference.js
function cy(e, t) {
	let n = String(t.identifier).toUpperCase(), r = e.definitionById.get(n);
	if (!r) return sy(e, t);
	let i = {
		src: Eg(r.url || ""),
		alt: t.alt
	};
	r.title !== null && r.title !== void 0 && (i.title = r.title);
	let a = {
		type: "element",
		tagName: "img",
		properties: i,
		children: []
	};
	return e.patch(t, a), e.applyData(t, a);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/image.js
function ly(e, t) {
	let n = { src: Eg(t.url) };
	t.alt !== null && t.alt !== void 0 && (n.alt = t.alt), t.title !== null && t.title !== void 0 && (n.title = t.title);
	let r = {
		type: "element",
		tagName: "img",
		properties: n,
		children: []
	};
	return e.patch(t, r), e.applyData(t, r);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/inline-code.js
function uy(e, t) {
	let n = {
		type: "text",
		value: t.value.replace(/\r?\n|\r/g, " ")
	};
	e.patch(t, n);
	let r = {
		type: "element",
		tagName: "code",
		properties: {},
		children: [n]
	};
	return e.patch(t, r), e.applyData(t, r);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/link-reference.js
function dy(e, t) {
	let n = String(t.identifier).toUpperCase(), r = e.definitionById.get(n);
	if (!r) return sy(e, t);
	let i = { href: Eg(r.url || "") };
	r.title !== null && r.title !== void 0 && (i.title = r.title);
	let a = {
		type: "element",
		tagName: "a",
		properties: i,
		children: e.all(t)
	};
	return e.patch(t, a), e.applyData(t, a);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/link.js
function fy(e, t) {
	let n = { href: Eg(t.url) };
	t.title !== null && t.title !== void 0 && (n.title = t.title);
	let r = {
		type: "element",
		tagName: "a",
		properties: n,
		children: e.all(t)
	};
	return e.patch(t, r), e.applyData(t, r);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/list-item.js
function py(e, t, n) {
	let r = e.all(t), i = n ? my(n) : hy(t), a = {}, o = [];
	if (typeof t.checked == "boolean") {
		let e = r[0], n;
		e && e.type === "element" && e.tagName === "p" ? n = e : (n = {
			type: "element",
			tagName: "p",
			properties: {},
			children: []
		}, r.unshift(n)), n.children.length > 0 && n.children.unshift({
			type: "text",
			value: " "
		}), n.children.unshift({
			type: "element",
			tagName: "input",
			properties: {
				type: "checkbox",
				checked: t.checked,
				disabled: !0
			},
			children: []
		}), a.className = ["task-list-item"];
	}
	let s = -1;
	for (; ++s < r.length;) {
		let e = r[s];
		(i || s !== 0 || e.type !== "element" || e.tagName !== "p") && o.push({
			type: "text",
			value: "\n"
		}), e.type === "element" && e.tagName === "p" && !i ? o.push(...e.children) : o.push(e);
	}
	let c = r[r.length - 1];
	c && (i || c.type !== "element" || c.tagName !== "p") && o.push({
		type: "text",
		value: "\n"
	});
	let l = {
		type: "element",
		tagName: "li",
		properties: a,
		children: o
	};
	return e.patch(t, l), e.applyData(t, l);
}
function my(e) {
	let t = !1;
	if (e.type === "list") {
		t = e.spread || !1;
		let n = e.children, r = -1;
		for (; !t && ++r < n.length;) t = hy(n[r]);
	}
	return t;
}
function hy(e) {
	return e.spread ?? e.children.length > 1;
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/list.js
function gy(e, t) {
	let n = {}, r = e.all(t), i = -1;
	for (typeof t.start == "number" && t.start !== 1 && (n.start = t.start); ++i < r.length;) {
		let e = r[i];
		if (e.type === "element" && e.tagName === "li" && e.properties && Array.isArray(e.properties.className) && e.properties.className.includes("task-list-item")) {
			n.className = ["contains-task-list"];
			break;
		}
	}
	let a = {
		type: "element",
		tagName: t.ordered ? "ol" : "ul",
		properties: n,
		children: e.wrap(r, !0)
	};
	return e.patch(t, a), e.applyData(t, a);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/paragraph.js
function _y(e, t) {
	let n = {
		type: "element",
		tagName: "p",
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/root.js
function vy(e, t) {
	let n = {
		type: "root",
		children: e.wrap(e.all(t))
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/strong.js
function yy(e, t) {
	let n = {
		type: "element",
		tagName: "strong",
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/table.js
function by(e, t) {
	let n = e.all(t), r = n.shift(), i = [];
	if (r) {
		let n = {
			type: "element",
			tagName: "thead",
			properties: {},
			children: e.wrap([r], !0)
		};
		e.patch(t.children[0], n), i.push(n);
	}
	if (n.length > 0) {
		let r = {
			type: "element",
			tagName: "tbody",
			properties: {},
			children: e.wrap(n, !0)
		}, a = gh(t.children[1]), o = hh(t.children[t.children.length - 1]);
		a && o && (r.position = {
			start: a,
			end: o
		}), i.push(r);
	}
	let a = {
		type: "element",
		tagName: "table",
		properties: {},
		children: e.wrap(i, !0)
	};
	return e.patch(t, a), e.applyData(t, a);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/table-row.js
function xy(e, t, n) {
	let r = n ? n.children : void 0, i = (r ? r.indexOf(t) : 1) === 0 ? "th" : "td", a = n && n.type === "table" ? n.align : void 0, o = a ? a.length : t.children.length, s = -1, c = [];
	for (; ++s < o;) {
		let n = t.children[s], r = {}, o = a ? a[s] : void 0;
		o && (r.align = o);
		let l = {
			type: "element",
			tagName: i,
			properties: r,
			children: []
		};
		n && (l.children = e.all(n), e.patch(n, l), l = e.applyData(n, l)), c.push(l);
	}
	let l = {
		type: "element",
		tagName: "tr",
		properties: {},
		children: e.wrap(c, !0)
	};
	return e.patch(t, l), e.applyData(t, l);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/table-cell.js
function Sy(e, t) {
	let n = {
		type: "element",
		tagName: "td",
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/trim-lines/index.js
var Cy = 9, wy = 32;
function Ty(e) {
	let t = String(e), n = /\r?\n|\r/g, r = n.exec(t), i = 0, a = [];
	for (; r;) a.push(Ey(t.slice(i, r.index), i > 0, !0), r[0]), i = r.index + r[0].length, r = n.exec(t);
	return a.push(Ey(t.slice(i), i > 0, !1)), a.join("");
}
function Ey(e, t, n) {
	let r = 0, i = e.length;
	if (t) {
		let t = e.codePointAt(r);
		for (; t === Cy || t === wy;) r++, t = e.codePointAt(r);
	}
	if (n) {
		let t = e.codePointAt(i - 1);
		for (; t === Cy || t === wy;) i--, t = e.codePointAt(i - 1);
	}
	return i > r ? e.slice(r, i) : "";
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/text.js
function Dy(e, t) {
	let n = {
		type: "text",
		value: Ty(String(t.value))
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/thematic-break.js
function Oy(e, t) {
	let n = {
		type: "element",
		tagName: "hr",
		properties: {},
		children: []
	};
	return e.patch(t, n), e.applyData(t, n);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/handlers/index.js
var ky = {
	blockquote: $v,
	break: ey,
	code: ty,
	delete: ny,
	emphasis: ry,
	footnoteReference: iy,
	heading: ay,
	html: oy,
	imageReference: cy,
	image: ly,
	inlineCode: uy,
	linkReference: dy,
	link: fy,
	listItem: py,
	list: gy,
	paragraph: _y,
	root: vy,
	strong: yy,
	table: by,
	tableCell: Sy,
	tableRow: xy,
	text: Dy,
	thematicBreak: Oy,
	toml: Ay,
	yaml: Ay,
	definition: Ay,
	footnoteDefinition: Ay
};
function Ay() {}
//#endregion
//#region node_modules/@ungap/structured-clone/esm/deserialize.js
var { defineProperty: jy } = Object, My = typeof self == "object" ? self : globalThis, Ny = (e, t) => {
	switch (e) {
		case "Function":
		case "SharedWorker":
		case "Worker":
		case "eval":
		case "setInterval":
		case "setTimeout": throw TypeError("unable to deserialize " + e);
	}
	return new My[e](t);
}, Py = (e, t) => {
	let n = (t, n) => (e.set(n, t), t), r = (i) => {
		if (e.has(i)) return e.get(i);
		let [a, o] = t[i];
		switch (a) {
			case 0:
			case -1: return n(o, i);
			case 1: {
				let e = n([], i);
				for (let t of o) e.push(r(t));
				return e;
			}
			case 2: {
				let e = n({}, i);
				for (let [t, n] of o) {
					let i = r(t), a = r(n);
					i === "__proto__" ? jy(e, i, {
						value: a,
						configurable: !0,
						enumerable: !0,
						writable: !0
					}) : e[i] = a;
				}
				return e;
			}
			case 3: return n(new Date(o), i);
			case 4: {
				let { source: e, flags: t } = o;
				return n(new RegExp(e, t), i);
			}
			case 5: {
				let e = n(/* @__PURE__ */ new Map(), i);
				for (let [t, n] of o) e.set(r(t), r(n));
				return e;
			}
			case 6: {
				let e = n(/* @__PURE__ */ new Set(), i);
				for (let t of o) e.add(r(t));
				return e;
			}
			case 7: {
				let { name: e, message: t } = o;
				return n(typeof My[e] == "function" ? Ny(e, t) : Error(t), i);
			}
			case 8: return n(BigInt(o), i);
			case "BigInt": return n(Object(BigInt(o)), i);
			case "ArrayBuffer": return n(new Uint8Array(o).buffer, o);
			case "DataView": {
				let { buffer: e } = new Uint8Array(o);
				return n(new DataView(e), o);
			}
			case "-0": return -0;
		}
		return n(Ny(a, o), i);
	};
	return r;
}, Fy = (e) => Py(/* @__PURE__ */ new Map(), e)(0), Iy = "", { toString: Ly } = {}, { keys: Ry, is: zy } = Object, By = (e) => {
	let t = typeof e;
	if (t !== "object" || !e) return [0, t];
	let n = Ly.call(e).slice(8, -1);
	switch (n) {
		case "Array": return [1, Iy];
		case "Object": return [2, Iy];
		case "Date": return [3, Iy];
		case "RegExp": return [4, Iy];
		case "Map": return [5, Iy];
		case "Set": return [6, Iy];
		case "DataView": return [1, n];
	}
	return n.includes("Array") ? [1, n] : e instanceof Error ? [7, e.name || "Error"] : [2, n];
}, Vy = ([e, t]) => e === 0 && (t === "function" || t === "symbol"), Hy = (e, t, n, r) => {
	let i = (e, t) => {
		let i = r.push(e) - 1;
		return n.set(t, i), i;
	}, a = (o) => {
		if (n.has(o)) return n.get(o);
		let [s, c] = By(o);
		switch (s) {
			case 0: {
				let t = o;
				switch (c) {
					case "bigint":
						s = 8, t = o.toString();
						break;
					case "number":
						if (!o && zy(o, -0)) return r.push(["-0"]) - 1;
						break;
					case "function":
					case "symbol":
						if (e) throw TypeError("unable to serialize " + c);
						t = null;
						break;
					case "undefined": return i([-1], o);
				}
				return i([s, t], o);
			}
			case 1: {
				if (c) {
					let e = o;
					return c === "DataView" ? e = new Uint8Array(o.buffer) : c === "ArrayBuffer" && (e = new Uint8Array(o)), i([c, [...e]], o);
				}
				let e = [], t = i([s, e], o);
				for (let t of o) e.push(a(t));
				return t;
			}
			case 2: {
				if (c) switch (c) {
					case "BigInt": return i([c, o.toString()], o);
					case "Boolean":
					case "Number":
					case "String": return i([c, o.valueOf()], o);
				}
				if (t && "toJSON" in o) return a(o.toJSON());
				let n = [], r = i([s, n], o);
				for (let t of Ry(o)) (e || !Vy(By(o[t]))) && n.push([a(t), a(o[t])]);
				return r;
			}
			case 3: return i([s, isNaN(o.getTime()) ? Iy : o.toISOString()], o);
			case 4: {
				let { source: e, flags: t } = o;
				return i([s, {
					source: e,
					flags: t
				}], o);
			}
			case 5: {
				let t = [], n = i([s, t], o);
				for (let [n, r] of o) (e || !(Vy(By(n)) || Vy(By(r)))) && t.push([a(n), a(r)]);
				return n;
			}
			case 6: {
				let t = [], n = i([s, t], o);
				for (let n of o) (e || !Vy(By(n))) && t.push(a(n));
				return n;
			}
		}
		let { message: l } = o;
		return i([s, {
			name: c,
			message: l
		}], o);
	};
	return a;
}, Uy = (e, { json: t, lossy: n } = {}) => {
	let r = [];
	return Hy(!(t || n), !!t, /* @__PURE__ */ new Map(), r)(e), r;
}, Wy = typeof structuredClone == "function" ?
/* c8 ignore start */
(e, t) => t && ("json" in t || "lossy" in t) ? Fy(Uy(e, t)) : structuredClone(e) : (e, t) => Fy(Uy(e, t));
//#endregion
//#region node_modules/mdast-util-to-hast/lib/footer.js
function Gy(e, t) {
	let n = [{
		type: "text",
		value: "↩"
	}];
	return t > 1 && n.push({
		type: "element",
		tagName: "sup",
		properties: {},
		children: [{
			type: "text",
			value: String(t)
		}]
	}), n;
}
function Ky(e, t) {
	return "Back to reference " + (e + 1) + (t > 1 ? "-" + t : "");
}
function qy(e) {
	let t = typeof e.options.clobberPrefix == "string" ? e.options.clobberPrefix : "user-content-", n = e.options.footnoteBackContent || Gy, r = e.options.footnoteBackLabel || Ky, i = e.options.footnoteLabel || "Footnotes", a = e.options.footnoteLabelTagName || "h2", o = e.options.footnoteLabelProperties || { className: ["sr-only"] }, s = [], c = -1;
	for (; ++c < e.footnoteOrder.length;) {
		let i = e.footnoteById.get(e.footnoteOrder[c]);
		if (!i) continue;
		let a = e.all(i), o = String(i.identifier).toUpperCase(), l = Eg(o.toLowerCase()), u = 0, d = [], f = e.footnoteCounts.get(o);
		for (; f !== void 0 && ++u <= f;) {
			d.length > 0 && d.push({
				type: "text",
				value: " "
			});
			let e = typeof n == "string" ? n : n(c, u);
			typeof e == "string" && (e = {
				type: "text",
				value: e
			}), d.push({
				type: "element",
				tagName: "a",
				properties: {
					href: "#" + t + "fnref-" + l + (u > 1 ? "-" + u : ""),
					dataFootnoteBackref: "",
					ariaLabel: typeof r == "string" ? r : r(c, u),
					className: ["data-footnote-backref"]
				},
				children: Array.isArray(e) ? e : [e]
			});
		}
		let p = a[a.length - 1];
		if (p && p.type === "element" && p.tagName === "p") {
			let e = p.children[p.children.length - 1];
			e && e.type === "text" ? e.value += " " : p.children.push({
				type: "text",
				value: " "
			}), p.children.push(...d);
		} else a.push(...d);
		let m = {
			type: "element",
			tagName: "li",
			properties: { id: t + "fn-" + l },
			children: e.wrap(a, !0)
		};
		e.patch(i, m), s.push(m);
	}
	if (s.length !== 0) return {
		type: "element",
		tagName: "section",
		properties: {
			dataFootnotes: !0,
			className: ["footnotes"]
		},
		children: [
			{
				type: "element",
				tagName: a,
				properties: {
					...Wy(o),
					id: "footnote-label"
				},
				children: [{
					type: "text",
					value: i
				}]
			},
			{
				type: "text",
				value: "\n"
			},
			{
				type: "element",
				tagName: "ol",
				properties: {},
				children: e.wrap(s, !0)
			},
			{
				type: "text",
				value: "\n"
			}
		]
	};
}
//#endregion
//#region node_modules/unist-util-is/lib/index.js
var Jy = (function(e) {
	if (e == null) return $y;
	if (typeof e == "function") return Qy(e);
	if (typeof e == "object") return Array.isArray(e) ? Yy(e) : Xy(e);
	if (typeof e == "string") return Zy(e);
	throw Error("Expected function, string, or object as test");
});
function Yy(e) {
	let t = [], n = -1;
	for (; ++n < e.length;) t[n] = Jy(e[n]);
	return Qy(r);
	function r(...e) {
		let n = -1;
		for (; ++n < t.length;) if (t[n].apply(this, e)) return !0;
		return !1;
	}
}
function Xy(e) {
	let t = e;
	return Qy(n);
	function n(n) {
		let r = n, i;
		for (i in e) if (r[i] !== t[i]) return !1;
		return !0;
	}
}
function Zy(e) {
	return Qy(t);
	function t(t) {
		return t && t.type === e;
	}
}
function Qy(e) {
	return t;
	function t(t, n, r) {
		return !!(eb(t) && e.call(this, t, typeof n == "number" ? n : void 0, r || void 0));
	}
}
function $y() {
	return !0;
}
function eb(e) {
	return typeof e == "object" && !!e && "type" in e;
}
//#endregion
//#region node_modules/unist-util-visit-parents/lib/color.js
function tb(e) {
	return e;
}
//#endregion
//#region node_modules/unist-util-visit-parents/lib/index.js
var nb = [];
function rb(e, t, n, r) {
	let i;
	typeof t == "function" && typeof n != "function" ? (r = n, n = t) : i = t;
	let a = Jy(i), o = r ? -1 : 1;
	s(e, void 0, [])();
	function s(e, i, c) {
		let l = e && typeof e == "object" ? e : {};
		if (typeof l.type == "string") {
			let t = typeof l.tagName == "string" ? l.tagName : typeof l.name == "string" ? l.name : void 0;
			Object.defineProperty(u, "name", { value: "node (" + tb(e.type + (t ? "<" + t + ">" : "")) + ")" });
		}
		return u;
		function u() {
			let l = nb, u, d, f;
			if ((!t || a(e, i, c[c.length - 1] || void 0)) && (l = ib(n(e, c)), l[0] === !1)) return l;
			if ("children" in e && e.children) {
				let t = e;
				if (t.children && l[0] !== "skip") for (d = (r ? t.children.length : -1) + o, f = c.concat(t); d > -1 && d < t.children.length;) {
					let e = t.children[d];
					if (u = s(e, d, f)(), u[0] === !1) return u;
					d = typeof u[1] == "number" ? u[1] : d + o;
				}
			}
			return l;
		}
	}
}
function ib(e) {
	return Array.isArray(e) ? e : typeof e == "number" ? [!0, e] : e == null ? nb : [e];
}
//#endregion
//#region node_modules/unist-util-visit/lib/index.js
function ab(e, t, n, r) {
	let i, a, o;
	typeof t == "function" && typeof n != "function" ? (a = void 0, o = t, i = n) : (a = t, o = n, i = r), rb(e, a, s, i);
	function s(e, t) {
		let n = t[t.length - 1], r = n ? n.children.indexOf(e) : void 0;
		return o(e, r, n);
	}
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/state.js
var ob = {}.hasOwnProperty, sb = {};
function cb(e, t) {
	let n = t || sb, r = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Map(), a = {
		all: s,
		applyData: ub,
		definitionById: r,
		footnoteById: i,
		footnoteCounts: /* @__PURE__ */ new Map(),
		footnoteOrder: [],
		handlers: {
			...ky,
			...n.handlers
		},
		one: o,
		options: n,
		patch: lb,
		wrap: fb
	};
	return ab(e, function(e) {
		if (e.type === "definition" || e.type === "footnoteDefinition") {
			let t = e.type === "definition" ? r : i, n = String(e.identifier).toUpperCase();
			t.has(n) || t.set(n, e);
		}
	}), a;
	function o(e, t) {
		let n = e.type, r = a.handlers[n];
		if (ob.call(a.handlers, n) && r) return r(a, e, t);
		if (a.options.passThrough && a.options.passThrough.includes(n)) {
			if ("children" in e) {
				let { children: t, ...n } = e, r = Wy(n);
				return r.children = a.all(e), r;
			}
			return Wy(e);
		}
		return (a.options.unknownHandler || db)(a, e, t);
	}
	function s(e) {
		let t = [];
		if ("children" in e) {
			let n = e.children, r = -1;
			for (; ++r < n.length;) {
				let i = a.one(n[r], e);
				if (i) {
					if (r && n[r - 1].type === "break" && (!Array.isArray(i) && i.type === "text" && (i.value = pb(i.value)), !Array.isArray(i) && i.type === "element")) {
						let e = i.children[0];
						e && e.type === "text" && (e.value = pb(e.value));
					}
					Array.isArray(i) ? t.push(...i) : t.push(i);
				}
			}
		}
		return t;
	}
}
function lb(e, t) {
	e.position && (t.position = vh(e));
}
function ub(e, t) {
	let n = t;
	if (e && e.data) {
		let t = e.data.hName, r = e.data.hChildren, i = e.data.hProperties;
		typeof t == "string" && (n.type === "element" ? n.tagName = t : n = {
			type: "element",
			tagName: t,
			properties: {},
			children: "children" in n ? n.children : [n]
		}), n.type === "element" && i && Object.assign(n.properties, Wy(i)), "children" in n && n.children && r != null && (n.children = r);
	}
	return n;
}
function db(e, t) {
	let n = t.data || {}, r = "value" in t && !(ob.call(n, "hProperties") || ob.call(n, "hChildren")) ? {
		type: "text",
		value: t.value
	} : {
		type: "element",
		tagName: "div",
		properties: {},
		children: e.all(t)
	};
	return e.patch(t, r), e.applyData(t, r);
}
function fb(e, t) {
	let n = [], r = -1;
	for (t && n.push({
		type: "text",
		value: "\n"
	}); ++r < e.length;) r && n.push({
		type: "text",
		value: "\n"
	}), n.push(e[r]);
	return t && e.length > 0 && n.push({
		type: "text",
		value: "\n"
	}), n;
}
function pb(e) {
	let t = 0, n = e.charCodeAt(t);
	for (; n === 9 || n === 32;) t++, n = e.charCodeAt(t);
	return e.slice(t);
}
//#endregion
//#region node_modules/mdast-util-to-hast/lib/index.js
function mb(e, t) {
	let n = cb(e, t), r = n.one(e, void 0), i = qy(n), a = Array.isArray(r) ? {
		type: "root",
		children: r
	} : r || {
		type: "root",
		children: []
	};
	return i && ("children" in a, a.children.push({
		type: "text",
		value: "\n"
	}, i)), a;
}
//#endregion
//#region node_modules/remark-rehype/lib/index.js
function hb(e, t) {
	return e && "run" in e ? async function(n, r) {
		let i = mb(n, {
			file: r,
			...t
		});
		await e.run(i, r);
	} : function(n, r) {
		return mb(n, {
			file: r,
			...e || t
		});
	};
}
//#endregion
//#region node_modules/bail/index.js
function gb(e) {
	if (e) throw e;
}
//#endregion
//#region node_modules/extend/index.js
var _b = /* @__PURE__ */ o(((e, t) => {
	var n = Object.prototype.hasOwnProperty, r = Object.prototype.toString, i = Object.defineProperty, a = Object.getOwnPropertyDescriptor, o = function(e) {
		return typeof Array.isArray == "function" ? Array.isArray(e) : r.call(e) === "[object Array]";
	}, s = function(e) {
		if (!e || r.call(e) !== "[object Object]") return !1;
		var t = n.call(e, "constructor"), i = e.constructor && e.constructor.prototype && n.call(e.constructor.prototype, "isPrototypeOf");
		if (e.constructor && !t && !i) return !1;
		for (var a in e);
		return a === void 0 || n.call(e, a);
	}, c = function(e, t) {
		i && t.name === "__proto__" ? i(e, t.name, {
			enumerable: !0,
			configurable: !0,
			value: t.newValue,
			writable: !0
		}) : e[t.name] = t.newValue;
	}, l = function(e, t) {
		if (t === "__proto__") {
			if (!n.call(e, t)) return;
			if (a) return a(e, t).value;
		}
		return e[t];
	};
	t.exports = function e() {
		var t, n, r, i, a, u, d = arguments[0], f = 1, p = arguments.length, m = !1;
		for (typeof d == "boolean" && (m = d, d = arguments[1] || {}, f = 2), (d == null || typeof d != "object" && typeof d != "function") && (d = {}); f < p; ++f) if (t = arguments[f], t != null) for (n in t) r = l(d, n), i = l(t, n), d !== i && (m && i && (s(i) || (a = o(i))) ? (a ? (a = !1, u = r && o(r) ? r : []) : u = r && s(r) ? r : {}, c(d, {
			name: n,
			newValue: e(m, u, i)
		})) : i !== void 0 && c(d, {
			name: n,
			newValue: i
		}));
		return d;
	};
}));
//#endregion
//#region node_modules/is-plain-obj/index.js
function vb(e) {
	if (typeof e != "object" || !e) return !1;
	let t = Object.getPrototypeOf(e);
	return (t === null || t === Object.prototype || Object.getPrototypeOf(t) === null) && !(Symbol.toStringTag in e) && !(Symbol.iterator in e);
}
//#endregion
//#region node_modules/trough/lib/index.js
function yb() {
	let e = [], t = {
		run: n,
		use: r
	};
	return t;
	function n(...t) {
		let n = -1, r = t.pop();
		if (typeof r != "function") throw TypeError("Expected function as last argument, not " + r);
		i(null, ...t);
		function i(a, ...o) {
			let s = e[++n], c = -1;
			if (a) {
				r(a);
				return;
			}
			for (; ++c < t.length;) (o[c] === null || o[c] === void 0) && (o[c] = t[c]);
			t = o, s ? bb(s, i)(...o) : r(null, ...o);
		}
	}
	function r(n) {
		if (typeof n != "function") throw TypeError("Expected `middelware` to be a function, not " + n);
		return e.push(n), t;
	}
}
function bb(e, t) {
	let n;
	return r;
	function r(...t) {
		let r = e.length > t.length, o;
		r && t.push(i);
		try {
			o = e.apply(this, t);
		} catch (e) {
			let t = e;
			if (r && n) throw t;
			return i(t);
		}
		r || (o && o.then && typeof o.then == "function" ? o.then(a, i) : o instanceof Error ? i(o) : a(o));
	}
	function i(e, ...r) {
		n || (n = !0, t(e, ...r));
	}
	function a(e) {
		i(null, e);
	}
}
//#endregion
//#region node_modules/vfile/lib/minpath.browser.js
var xb = {
	basename: Sb,
	dirname: Cb,
	extname: wb,
	join: Tb,
	sep: "/"
};
function Sb(e, t) {
	if (t !== void 0 && typeof t != "string") throw TypeError("\"ext\" argument must be a string");
	Ob(e);
	let n = 0, r = -1, i = e.length, a;
	if (t === void 0 || t.length === 0 || t.length > e.length) {
		for (; i--;) if (e.codePointAt(i) === 47) {
			if (a) {
				n = i + 1;
				break;
			}
		} else r < 0 && (a = !0, r = i + 1);
		return r < 0 ? "" : e.slice(n, r);
	}
	if (t === e) return "";
	let o = -1, s = t.length - 1;
	for (; i--;) if (e.codePointAt(i) === 47) {
		if (a) {
			n = i + 1;
			break;
		}
	} else o < 0 && (a = !0, o = i + 1), s > -1 && (e.codePointAt(i) === t.codePointAt(s--) ? s < 0 && (r = i) : (s = -1, r = o));
	return n === r ? r = o : r < 0 && (r = e.length), e.slice(n, r);
}
function Cb(e) {
	if (Ob(e), e.length === 0) return ".";
	let t = -1, n = e.length, r;
	for (; --n;) if (e.codePointAt(n) === 47) {
		if (r) {
			t = n;
			break;
		}
	} else r ||= !0;
	return t < 0 ? e.codePointAt(0) === 47 ? "/" : "." : t === 1 && e.codePointAt(0) === 47 ? "//" : e.slice(0, t);
}
function wb(e) {
	Ob(e);
	let t = e.length, n = -1, r = 0, i = -1, a = 0, o;
	for (; t--;) {
		let s = e.codePointAt(t);
		if (s === 47) {
			if (o) {
				r = t + 1;
				break;
			}
			continue;
		}
		n < 0 && (o = !0, n = t + 1), s === 46 ? i < 0 ? i = t : a !== 1 && (a = 1) : i > -1 && (a = -1);
	}
	return i < 0 || n < 0 || a === 0 || a === 1 && i === n - 1 && i === r + 1 ? "" : e.slice(i, n);
}
function Tb(...e) {
	let t = -1, n;
	for (; ++t < e.length;) Ob(e[t]), e[t] && (n = n === void 0 ? e[t] : n + "/" + e[t]);
	return n === void 0 ? "." : Eb(n);
}
function Eb(e) {
	Ob(e);
	let t = e.codePointAt(0) === 47, n = Db(e, !t);
	return n.length === 0 && !t && (n = "."), n.length > 0 && e.codePointAt(e.length - 1) === 47 && (n += "/"), t ? "/" + n : n;
}
function Db(e, t) {
	let n = "", r = 0, i = -1, a = 0, o = -1, s, c;
	for (; ++o <= e.length;) {
		if (o < e.length) s = e.codePointAt(o);
		else if (s === 47) break;
		else s = 47;
		if (s === 47) {
			if (i !== o - 1 && a !== 1) {
				if (i !== o - 1 && a === 2) {
					if (n.length < 2 || r !== 2 || n.codePointAt(n.length - 1) !== 46 || n.codePointAt(n.length - 2) !== 46) {
						if (n.length > 2) {
							if (c = n.lastIndexOf("/"), c !== n.length - 1) {
								c < 0 ? (n = "", r = 0) : (n = n.slice(0, c), r = n.length - 1 - n.lastIndexOf("/")), i = o, a = 0;
								continue;
							}
						} else if (n.length > 0) {
							n = "", r = 0, i = o, a = 0;
							continue;
						}
					}
					t && (n = n.length > 0 ? n + "/.." : "..", r = 2);
				} else n.length > 0 ? n += "/" + e.slice(i + 1, o) : n = e.slice(i + 1, o), r = o - i - 1;
			}
			i = o, a = 0;
		} else s === 46 && a > -1 ? a++ : a = -1;
	}
	return n;
}
function Ob(e) {
	if (typeof e != "string") throw TypeError("Path must be a string. Received " + JSON.stringify(e));
}
//#endregion
//#region node_modules/vfile/lib/minproc.browser.js
var kb = { cwd: Ab };
function Ab() {
	return "/";
}
//#endregion
//#region node_modules/vfile/lib/minurl.shared.js
function jb(e) {
	return !!(typeof e == "object" && e && "href" in e && e.href && "protocol" in e && e.protocol && e.auth === void 0);
}
//#endregion
//#region node_modules/vfile/lib/minurl.browser.js
function Mb(e) {
	if (typeof e == "string") e = new URL(e);
	else if (!jb(e)) {
		let t = /* @__PURE__ */ TypeError("The \"path\" argument must be of type string or an instance of URL. Received `" + e + "`");
		throw t.code = "ERR_INVALID_ARG_TYPE", t;
	}
	if (e.protocol !== "file:") {
		let e = /* @__PURE__ */ TypeError("The URL must be of scheme file");
		throw e.code = "ERR_INVALID_URL_SCHEME", e;
	}
	return Nb(e);
}
function Nb(e) {
	if (e.hostname !== "") {
		let e = /* @__PURE__ */ TypeError("File URL host must be \"localhost\" or empty on darwin");
		throw e.code = "ERR_INVALID_FILE_URL_HOST", e;
	}
	let t = e.pathname, n = -1;
	for (; ++n < t.length;) if (t.codePointAt(n) === 37 && t.codePointAt(n + 1) === 50) {
		let e = t.codePointAt(n + 2);
		if (e === 70 || e === 102) {
			let e = /* @__PURE__ */ TypeError("File URL path must not include encoded / characters");
			throw e.code = "ERR_INVALID_FILE_URL_PATH", e;
		}
	}
	return decodeURIComponent(t);
}
//#endregion
//#region node_modules/vfile/lib/index.js
var Pb = [
	"history",
	"path",
	"basename",
	"stem",
	"extname",
	"dirname"
], Fb = class {
	constructor(e) {
		let t;
		t = e ? jb(e) ? { path: e } : typeof e == "string" || zb(e) ? { value: e } : e : {}, this.cwd = "cwd" in t ? "" : kb.cwd(), this.data = {}, this.history = [], this.messages = [], this.value, this.map, this.result, this.stored;
		let n = -1;
		for (; ++n < Pb.length;) {
			let e = Pb[n];
			e in t && t[e] !== void 0 && t[e] !== null && (this[e] = e === "history" ? [...t[e]] : t[e]);
		}
		let r;
		for (r in t) Pb.includes(r) || (this[r] = t[r]);
	}
	get basename() {
		return typeof this.path == "string" ? xb.basename(this.path) : void 0;
	}
	set basename(e) {
		Lb(e, "basename"), Ib(e, "basename"), this.path = xb.join(this.dirname || "", e);
	}
	get dirname() {
		return typeof this.path == "string" ? xb.dirname(this.path) : void 0;
	}
	set dirname(e) {
		Rb(this.basename, "dirname"), this.path = xb.join(e || "", this.basename);
	}
	get extname() {
		return typeof this.path == "string" ? xb.extname(this.path) : void 0;
	}
	set extname(e) {
		if (Ib(e, "extname"), Rb(this.dirname, "extname"), e) {
			if (e.codePointAt(0) !== 46) throw Error("`extname` must start with `.`");
			if (e.includes(".", 1)) throw Error("`extname` cannot contain multiple dots");
		}
		this.path = xb.join(this.dirname, this.stem + (e || ""));
	}
	get path() {
		return this.history[this.history.length - 1];
	}
	set path(e) {
		jb(e) && (e = Mb(e)), Lb(e, "path"), this.path !== e && this.history.push(e);
	}
	get stem() {
		return typeof this.path == "string" ? xb.basename(this.path, this.extname) : void 0;
	}
	set stem(e) {
		Lb(e, "stem"), Ib(e, "stem"), this.path = xb.join(this.dirname || "", e + (this.extname || ""));
	}
	fail(e, t, n) {
		let r = this.message(e, t, n);
		throw r.fatal = !0, r;
	}
	info(e, t, n) {
		let r = this.message(e, t, n);
		return r.fatal = void 0, r;
	}
	message(e, t, n) {
		let r = new Ch(e, t, n);
		return this.path && (r.name = this.path + ":" + r.name, r.file = this.path), r.fatal = !1, this.messages.push(r), r;
	}
	toString(e) {
		return this.value === void 0 ? "" : typeof this.value == "string" ? this.value : new TextDecoder(e || void 0).decode(this.value);
	}
};
function Ib(e, t) {
	if (e && e.includes(xb.sep)) throw Error("`" + t + "` cannot be a path: did not expect `" + xb.sep + "`");
}
function Lb(e, t) {
	if (!e) throw Error("`" + t + "` cannot be empty");
}
function Rb(e, t) {
	if (!e) throw Error("Setting `" + t + "` requires `path` to be set too");
}
function zb(e) {
	return !!(e && typeof e == "object" && "byteLength" in e && "byteOffset" in e);
}
//#endregion
//#region node_modules/unified/lib/callable-instance.js
var Bb = (function(e) {
	let t = this.constructor.prototype, n = t[e], r = function() {
		return n.apply(r, arguments);
	};
	return Object.setPrototypeOf(r, t), r;
}), Vb = /* @__PURE__ */ l(_b(), 1), Hb = {}.hasOwnProperty, Ub = new class e extends Bb {
	constructor() {
		super("copy"), this.Compiler = void 0, this.Parser = void 0, this.attachers = [], this.compiler = void 0, this.freezeIndex = -1, this.frozen = void 0, this.namespace = {}, this.parser = void 0, this.transformers = yb();
	}
	copy() {
		let t = new e(), n = -1;
		for (; ++n < this.attachers.length;) {
			let e = this.attachers[n];
			t.use(...e);
		}
		return t.data((0, Vb.default)(!0, {}, this.namespace)), t;
	}
	data(e, t) {
		return typeof e == "string" ? arguments.length === 2 ? (Kb("data", this.frozen), this.namespace[e] = t, this) : Hb.call(this.namespace, e) && this.namespace[e] || void 0 : e ? (Kb("data", this.frozen), this.namespace = e, this) : this.namespace;
	}
	freeze() {
		if (this.frozen) return this;
		let e = this;
		for (; ++this.freezeIndex < this.attachers.length;) {
			let [t, ...n] = this.attachers[this.freezeIndex];
			if (n[0] === !1) continue;
			n[0] === !0 && (n[0] = void 0);
			let r = t.call(e, ...n);
			typeof r == "function" && this.transformers.use(r);
		}
		return this.frozen = !0, this.freezeIndex = Infinity, this;
	}
	parse(e) {
		this.freeze();
		let t = Yb(e), n = this.parser || this.Parser;
		return Wb("parse", n), n(String(t), t);
	}
	process(e, t) {
		let n = this;
		return this.freeze(), Wb("process", this.parser || this.Parser), Gb("process", this.compiler || this.Compiler), t ? r(void 0, t) : new Promise(r);
		function r(r, i) {
			let a = Yb(e), o = n.parse(a);
			n.run(o, a, function(e, t, r) {
				if (e || !t || !r) return s(e);
				let i = t, a = n.stringify(i, r);
				Zb(a) ? r.value = a : r.result = a, s(e, r);
			});
			function s(e, n) {
				e || !n ? i(e) : r ? r(n) : t(void 0, n);
			}
		}
	}
	processSync(e) {
		let t = !1, n;
		return this.freeze(), Wb("processSync", this.parser || this.Parser), Gb("processSync", this.compiler || this.Compiler), this.process(e, r), Jb("processSync", "process", t), n;
		function r(e, r) {
			t = !0, gb(e), n = r;
		}
	}
	run(e, t, n) {
		qb(e), this.freeze();
		let r = this.transformers;
		return !n && typeof t == "function" && (n = t, t = void 0), n ? i(void 0, n) : new Promise(i);
		function i(i, a) {
			let o = Yb(t);
			r.run(e, o, s);
			function s(t, r, o) {
				let s = r || e;
				t ? a(t) : i ? i(s) : n(void 0, s, o);
			}
		}
	}
	runSync(e, t) {
		let n = !1, r;
		return this.run(e, t, i), Jb("runSync", "run", n), r;
		function i(e, t) {
			gb(e), r = t, n = !0;
		}
	}
	stringify(e, t) {
		this.freeze();
		let n = Yb(t), r = this.compiler || this.Compiler;
		return Gb("stringify", r), qb(e), r(e, n);
	}
	use(e, ...t) {
		let n = this.attachers, r = this.namespace;
		if (Kb("use", this.frozen), e != null) {
			if (typeof e == "function") s(e, t);
			else if (typeof e == "object") Array.isArray(e) ? o(e) : a(e);
			else throw TypeError("Expected usable value, not `" + e + "`");
		}
		return this;
		function i(e) {
			if (typeof e == "function") s(e, []);
			else if (typeof e == "object") {
				if (Array.isArray(e)) {
					let [t, ...n] = e;
					s(t, n);
				} else a(e);
			} else throw TypeError("Expected usable value, not `" + e + "`");
		}
		function a(e) {
			if (!("plugins" in e) && !("settings" in e)) throw Error("Expected usable value but received an empty preset, which is probably a mistake: presets typically come with `plugins` and sometimes with `settings`, but this has neither");
			o(e.plugins), e.settings && (r.settings = (0, Vb.default)(!0, r.settings, e.settings));
		}
		function o(e) {
			let t = -1;
			if (e != null) {
				if (Array.isArray(e)) for (; ++t < e.length;) {
					let n = e[t];
					i(n);
				}
				else throw TypeError("Expected a list of plugins, not `" + e + "`");
			}
		}
		function s(e, t) {
			let r = -1, i = -1;
			for (; ++r < n.length;) if (n[r][0] === e) {
				i = r;
				break;
			}
			if (i === -1) n.push([e, ...t]);
			else if (t.length > 0) {
				let [r, ...a] = t, o = n[i][1];
				vb(o) && vb(r) && (r = (0, Vb.default)(!0, o, r)), n[i] = [
					e,
					r,
					...a
				];
			}
		}
	}
}().freeze();
function Wb(e, t) {
	if (typeof t != "function") throw TypeError("Cannot `" + e + "` without `parser`");
}
function Gb(e, t) {
	if (typeof t != "function") throw TypeError("Cannot `" + e + "` without `compiler`");
}
function Kb(e, t) {
	if (t) throw Error("Cannot call `" + e + "` on a frozen processor.\nCreate a new processor first, by calling it: use `processor()` instead of `processor`.");
}
function qb(e) {
	if (!vb(e) || typeof e.type != "string") throw TypeError("Expected node, got `" + e + "`");
}
function Jb(e, t, n) {
	if (!n) throw Error("`" + e + "` finished async. Use `" + t + "` instead");
}
function Yb(e) {
	return Xb(e) ? e : new Fb(e);
}
function Xb(e) {
	return !!(e && typeof e == "object" && "message" in e && "messages" in e);
}
function Zb(e) {
	return typeof e == "string" || Qb(e);
}
function Qb(e) {
	return !!(e && typeof e == "object" && "byteLength" in e && "byteOffset" in e);
}
//#endregion
//#region node_modules/react-markdown/lib/index.js
var $b = [], ex = { allowDangerousHtml: !0 }, tx = /^(https?|ircs?|mailto|xmpp)$/i, nx = [
	{
		from: "astPlugins",
		id: "remove-buggy-html-in-markdown-parser"
	},
	{
		from: "allowDangerousHtml",
		id: "remove-buggy-html-in-markdown-parser"
	},
	{
		from: "allowNode",
		id: "replace-allownode-allowedtypes-and-disallowedtypes",
		to: "allowElement"
	},
	{
		from: "allowedTypes",
		id: "replace-allownode-allowedtypes-and-disallowedtypes",
		to: "allowedElements"
	},
	{
		from: "className",
		id: "remove-classname"
	},
	{
		from: "disallowedTypes",
		id: "replace-allownode-allowedtypes-and-disallowedtypes",
		to: "disallowedElements"
	},
	{
		from: "escapeHtml",
		id: "remove-buggy-html-in-markdown-parser"
	},
	{
		from: "includeElementIndex",
		id: "#remove-includeelementindex"
	},
	{
		from: "includeNodeIndex",
		id: "change-includenodeindex-to-includeelementindex"
	},
	{
		from: "linkTarget",
		id: "remove-linktarget"
	},
	{
		from: "plugins",
		id: "change-plugins-to-remarkplugins",
		to: "remarkPlugins"
	},
	{
		from: "rawSourcePos",
		id: "#remove-rawsourcepos"
	},
	{
		from: "renderers",
		id: "change-renderers-to-components",
		to: "components"
	},
	{
		from: "source",
		id: "change-source-to-children",
		to: "children"
	},
	{
		from: "sourcePos",
		id: "#remove-sourcepos"
	},
	{
		from: "transformImageUri",
		id: "#add-urltransform",
		to: "urlTransform"
	},
	{
		from: "transformLinkUri",
		id: "#add-urltransform",
		to: "urlTransform"
	}
];
function rx(e) {
	let t = ix(e), n = ax(e);
	return ox(t.runSync(t.parse(n), n), e);
}
function ix(e) {
	let t = e.rehypePlugins || $b, n = e.remarkPlugins || $b, r = e.remarkRehypeOptions ? {
		...e.remarkRehypeOptions,
		...ex
	} : ex;
	return Ub().use(Qv).use(n).use(hb, r).use(t);
}
function ax(e) {
	let t = e.children || "", n = new Fb();
	return typeof t == "string" ? n.value = t : "" + t, n;
}
function ox(e, t) {
	let n = t.allowedElements, r = t.allowElement, i = t.components, a = t.disallowedElements, o = t.skipHtml, s = t.unwrapDisallowed, c = t.urlTransform || sx;
	for (let e of nx) Object.hasOwn(t, e.from) && "" + e.from + (e.to ? "use `" + e.to + "` instead" : "remove it") + e.id;
	return ab(e, l), jh(e, {
		Fragment: H.Fragment,
		components: i,
		ignoreInvalidStyle: !0,
		jsx: H.jsx,
		jsxs: H.jsxs,
		passKeys: !0,
		passNode: !0
	});
	function l(e, t, i) {
		if (e.type === "raw" && i && typeof t == "number") return o ? i.children.splice(t, 1) : i.children[t] = {
			type: "text",
			value: e.value
		}, t;
		if (e.type === "element") {
			let t;
			for (t in $h) if (Object.hasOwn($h, t) && Object.hasOwn(e.properties, t)) {
				let n = e.properties[t], r = $h[t];
				(r === null || r.includes(e.tagName)) && (e.properties[t] = c(String(n || ""), t, e));
			}
		}
		if (e.type === "element") {
			let o = n ? !n.includes(e.tagName) : a ? a.includes(e.tagName) : !1;
			if (!o && r && typeof t == "number" && (o = !r(e, t, i)), o && i && typeof t == "number") return s && e.children ? i.children.splice(t, 1, ...e.children) : i.children.splice(t, 1), t;
		}
	}
}
function sx(e) {
	let t = e.indexOf(":"), n = e.indexOf("?"), r = e.indexOf("#"), i = e.indexOf("/");
	return t === -1 || i !== -1 && t > i || n !== -1 && t > n || r !== -1 && t > r || tx.test(e.slice(0, t)) ? e : "";
}
//#endregion
//#region node_modules/@assistant-ui/react-markdown/dist/primitives/MarkdownText.js
var { useSmooth: cx, useSmoothStatus: lx, withSmoothContextProvider: ux } = rm, dx = (0, j.memo)(({ text: e, overrideVersion: t, ...n }) => /* @__PURE__ */ (0, H.jsx)(rx, {
	...n,
	children: e
}));
dx.displayName = "MarkdownRenderer";
var fx = ({ text: e, ...t }) => {
	let n = (0, j.useDeferredValue)(e);
	return /* @__PURE__ */ (0, H.jsx)(dx, {
		text: n,
		...t
	});
}, px = (e) => typeof e == "object" && !!e && !Array.isArray(e), mx = (e, t, n = 1) => {
	if (Object.is(e, t)) return !0;
	if (n <= 0) return !1;
	if (Array.isArray(e) && Array.isArray(t)) {
		if (e.length !== t.length) return !1;
		for (let r = 0; r < e.length; r++) if (!mx(e[r], t[r], n - 1)) return !1;
		return !0;
	}
	if (px(e) && px(t)) {
		let r = Object.keys(e);
		return r.length === Object.keys(t).length && r.every((r) => Object.hasOwn(t, r) && mx(e[r], t[r], n - 1));
	}
	return !1;
};
function hx(e, t) {
	let n = (0, j.useRef)(e);
	return mx(e, n.current, t) || (n.current = e), n.current;
}
function gx(e) {
	let t = (0, j.useRef)(e), n = (e, t) => e[t], r = Object.keys(e), i = Object.keys(t.current);
	return r.length === i.length && r.every((r) => Object.hasOwn(t.current, r) && mx(n(e, r), n(t.current, r))) || (t.current = e), t.current;
}
var _x = ({ components: e, componentsByLanguage: t, smooth: n = !0, defer: r = !1, preprocess: i, ...a }) => {
	let { text: o } = cx(pf(), n), s = (0, j.useMemo)(() => i ? i(o) : o, [i, o]), { pre: c = um, code: l = dm, SyntaxHighlighter: u = fm, CodeHeader: d = pm } = e ?? {}, f = (0, j.useMemo)(() => ({
		Pre: c,
		Code: l,
		SyntaxHighlighter: u,
		CodeHeader: d
	}), [
		c,
		l,
		u,
		d
	]), p = Kd((e) => /* @__PURE__ */ (0, H.jsx)(Sm, {
		components: f,
		componentsByLanguage: t,
		...e
	})), m = Kd((e) => /* @__PURE__ */ (0, H.jsx)(lm, {
		fallbackPre: c,
		...e
	})), h = gx((0, j.useMemo)(() => {
		let { pre: t, code: n, SyntaxHighlighter: r, CodeHeader: i, ...a } = e ?? {};
		return {
			...a,
			pre: m,
			code: p
		};
	}, [
		p,
		m,
		e
	])), g = hx((0, j.useMemo)(() => ({
		components: f,
		componentsByLanguage: t
	}), [f, t]), 3), _ = r ? fx : dx, v = gx(a);
	return /* @__PURE__ */ (0, H.jsx)(_, {
		text: s,
		components: h,
		overrideVersion: g,
		...v
	});
}, vx = (0, j.forwardRef)(({ className: e, containerProps: t, containerComponent: n = "div", ...r }, i) => {
	let a = lx();
	return /* @__PURE__ */ (0, H.jsx)(n, {
		"data-status": a.type,
		...t,
		className: (0, gm.default)(e, t?.className),
		ref: i,
		children: /* @__PURE__ */ (0, H.jsx)(_x, { ...r })
	});
});
vx.displayName = "MarkdownTextPrimitive";
var yx = ux(vx);
//#endregion
//#region node_modules/ccount/index.js
function bx(e, t) {
	let n = String(e);
	if (typeof t != "string") throw TypeError("Expected character");
	let r = 0, i = n.indexOf(t);
	for (; i !== -1;) r++, i = n.indexOf(t, i + t.length);
	return r;
}
//#endregion
//#region node_modules/escape-string-regexp/index.js
function xx(e) {
	if (typeof e != "string") throw TypeError("Expected a string");
	return e.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}
//#endregion
//#region node_modules/mdast-util-find-and-replace/lib/index.js
function Sx(e, t, n) {
	let r = Jy((n || {}).ignore || []), i = Cx(t), a = -1;
	for (; ++a < i.length;) rb(e, "text", o);
	function o(e, t) {
		let n = -1, i;
		for (; ++n < t.length;) {
			let e = t[n], a = i ? i.children : void 0;
			if (r(e, a ? a.indexOf(e) : void 0, i)) return;
			i = e;
		}
		if (i) return s(e, t);
	}
	function s(e, t) {
		let n = t[t.length - 1], r = i[a][0], o = i[a][1], s = 0, c = n.children.indexOf(e), l = !1, u = [];
		r.lastIndex = 0;
		let d = r.exec(e.value);
		for (; d;) {
			let n = d.index, i = {
				index: d.index,
				input: d.input,
				stack: [...t, e]
			}, a = o(...d, i);
			if (typeof a == "string" && (a = a.length > 0 ? {
				type: "text",
				value: a
			} : void 0), a === !1 ? r.lastIndex = n + 1 : (s !== n && u.push({
				type: "text",
				value: e.value.slice(s, n)
			}), Array.isArray(a) ? u.push(...a) : a && u.push(a), s = n + d[0].length, l = !0), !r.global) break;
			d = r.exec(e.value);
		}
		return l ? (s < e.value.length && u.push({
			type: "text",
			value: e.value.slice(s)
		}), n.children.splice(c, 1, ...u)) : u = [e], c + u.length;
	}
}
function Cx(e) {
	let t = [];
	if (!Array.isArray(e)) throw TypeError("Expected find and replace tuple or list of tuples");
	let n = !e[0] || Array.isArray(e[0]) ? e : [e], r = -1;
	for (; ++r < n.length;) {
		let e = n[r];
		t.push([wx(e[0]), Tx(e[1])]);
	}
	return t;
}
function wx(e) {
	return typeof e == "string" ? new RegExp(xx(e), "g") : e;
}
function Tx(e) {
	return typeof e == "function" ? e : function() {
		return e;
	};
}
//#endregion
//#region node_modules/mdast-util-gfm-autolink-literal/lib/index.js
var Ex = "phrasing", Dx = [
	"autolink",
	"link",
	"image",
	"label"
];
function Ox() {
	return {
		transforms: [Ix],
		enter: {
			literalAutolink: Ax,
			literalAutolinkEmail: jx,
			literalAutolinkHttp: jx,
			literalAutolinkWww: jx
		},
		exit: {
			literalAutolink: Fx,
			literalAutolinkEmail: Px,
			literalAutolinkHttp: Mx,
			literalAutolinkWww: Nx
		}
	};
}
function kx() {
	return { unsafe: [
		{
			character: "@",
			before: "[+\\-.\\w]",
			after: "[\\-.\\w]",
			inConstruct: Ex,
			notInConstruct: Dx
		},
		{
			character: ".",
			before: "[Ww]",
			after: "[\\-.\\w]",
			inConstruct: Ex,
			notInConstruct: Dx
		},
		{
			character: ":",
			before: "[ps]",
			after: "\\/",
			inConstruct: Ex,
			notInConstruct: Dx
		}
	] };
}
function Ax(e) {
	this.enter({
		type: "link",
		title: null,
		url: "",
		children: []
	}, e);
}
function jx(e) {
	this.config.enter.autolinkProtocol.call(this, e);
}
function Mx(e) {
	this.config.exit.autolinkProtocol.call(this, e);
}
function Nx(e) {
	this.config.exit.data.call(this, e);
	let t = this.stack[this.stack.length - 1];
	t.type, t.url = "http://" + this.sliceSerialize(e);
}
function Px(e) {
	this.config.exit.autolinkEmail.call(this, e);
}
function Fx(e) {
	this.exit(e);
}
function Ix(e) {
	Sx(e, [[/(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi, Lx], [/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu, Rx]], { ignore: ["link", "linkReference"] });
}
function Lx(e, t, n, r, i) {
	let a = "";
	if (!Vx(i) || (/^w/i.test(t) && (n = t + n, t = "", a = "http://"), !zx(n))) return !1;
	let o = Bx(n + r);
	if (!o[0]) return !1;
	let s = {
		type: "link",
		title: null,
		url: a + t + o[0],
		children: [{
			type: "text",
			value: t + o[0]
		}]
	};
	return o[1] ? [s, {
		type: "text",
		value: o[1]
	}] : s;
}
function Rx(e, t, n, r) {
	return !Vx(r, !0) || /[-\d_]$/.test(n) ? !1 : {
		type: "link",
		title: null,
		url: "mailto:" + t + "@" + n,
		children: [{
			type: "text",
			value: t + "@" + n
		}]
	};
}
function zx(e) {
	let t = e.split(".");
	return !(t.length < 2 || t[t.length - 1] && (/_/.test(t[t.length - 1]) || !/[a-zA-Z\d]/.test(t[t.length - 1])) || t[t.length - 2] && (/_/.test(t[t.length - 2]) || !/[a-zA-Z\d]/.test(t[t.length - 2])));
}
function Bx(e) {
	let t = /[!"&'),.:;<>?\]}]+$/.exec(e);
	if (!t) return [e, void 0];
	e = e.slice(0, t.index);
	let n = t[0], r = n.indexOf(")"), i = bx(e, "("), a = bx(e, ")");
	for (; r !== -1 && i > a;) e += n.slice(0, r + 1), n = n.slice(r + 1), r = n.indexOf(")"), a++;
	return [e, n];
}
function Vx(e, t) {
	let n = e.input.charCodeAt(e.index - 1);
	return (e.index === 0 || wg(n) || Cg(n)) && (!t || n !== 47);
}
//#endregion
//#region node_modules/mdast-util-gfm-footnote/lib/index.js
Zx.peek = Xx;
function Hx() {
	this.buffer();
}
function Ux(e) {
	this.enter({
		type: "footnoteReference",
		identifier: "",
		label: ""
	}, e);
}
function Wx() {
	this.buffer();
}
function Gx(e) {
	this.enter({
		type: "footnoteDefinition",
		identifier: "",
		label: "",
		children: []
	}, e);
}
function Kx(e) {
	let t = this.resume(), n = this.stack[this.stack.length - 1];
	n.type, n.identifier = mg(this.sliceSerialize(e)).toLowerCase(), n.label = t;
}
function qx(e) {
	this.exit(e);
}
function Jx(e) {
	let t = this.resume(), n = this.stack[this.stack.length - 1];
	n.type, n.identifier = mg(this.sliceSerialize(e)).toLowerCase(), n.label = t;
}
function Yx(e) {
	this.exit(e);
}
function Xx() {
	return "[";
}
function Zx(e, t, n, r) {
	let i = n.createTracker(r), a = i.move("[^"), o = n.enter("footnoteReference"), s = n.enter("reference");
	return a += i.move(n.safe(n.associationId(e), {
		after: "]",
		before: a
	})), s(), o(), a += i.move("]"), a;
}
function Qx() {
	return {
		enter: {
			gfmFootnoteCallString: Hx,
			gfmFootnoteCall: Ux,
			gfmFootnoteDefinitionLabelString: Wx,
			gfmFootnoteDefinition: Gx
		},
		exit: {
			gfmFootnoteCallString: Kx,
			gfmFootnoteCall: qx,
			gfmFootnoteDefinitionLabelString: Jx,
			gfmFootnoteDefinition: Yx
		}
	};
}
function $x(e) {
	let t = !1;
	return e && e.firstLineBlank && (t = !0), {
		handlers: {
			footnoteDefinition: n,
			footnoteReference: Zx
		},
		unsafe: [{
			character: "[",
			inConstruct: [
				"label",
				"phrasing",
				"reference"
			]
		}]
	};
	function n(e, n, r, i) {
		let a = r.createTracker(i), o = a.move("[^"), s = r.enter("footnoteDefinition"), c = r.enter("label");
		return o += a.move(r.safe(r.associationId(e), {
			before: o,
			after: "]"
		})), c(), o += a.move("]:"), e.children && e.children.length > 0 && (a.shift(4), o += a.move((t ? "\n" : " ") + r.indentLines(r.containerFlow(e, a.current()), t ? tS : eS))), s(), o;
	}
}
function eS(e, t, n) {
	return t === 0 ? e : tS(e, t, n);
}
function tS(e, t, n) {
	return (n ? "" : "    ") + e;
}
//#endregion
//#region node_modules/mdast-util-gfm-strikethrough/lib/index.js
var nS = [
	"autolink",
	"destinationLiteral",
	"destinationRaw",
	"reference",
	"titleQuote",
	"titleApostrophe"
];
sS.peek = cS;
function rS() {
	return {
		canContainEols: ["delete"],
		enter: { strikethrough: aS },
		exit: { strikethrough: oS }
	};
}
function iS() {
	return {
		unsafe: [{
			character: "~",
			inConstruct: "phrasing",
			notInConstruct: nS
		}],
		handlers: { delete: sS }
	};
}
function aS(e) {
	this.enter({
		type: "delete",
		children: []
	}, e);
}
function oS(e) {
	this.exit(e);
}
function sS(e, t, n, r) {
	let i = n.createTracker(r), a = n.enter("strikethrough"), o = i.move("~~");
	return o += n.containerPhrasing(e, {
		...i.current(),
		before: o,
		after: "~"
	}), o += i.move("~~"), a(), o;
}
function cS() {
	return "~";
}
//#endregion
//#region node_modules/markdown-table/index.js
function lS(e) {
	return e.length;
}
function uS(e, t) {
	let n = t || {}, r = (n.align || []).concat(), i = n.stringLength || lS, a = [], o = [], s = [], c = [], l = 0, u = -1;
	for (; ++u < e.length;) {
		let t = [], r = [], a = -1;
		for (e[u].length > l && (l = e[u].length); ++a < e[u].length;) {
			let o = dS(e[u][a]);
			if (n.alignDelimiters !== !1) {
				let e = i(o);
				r[a] = e, (c[a] === void 0 || e > c[a]) && (c[a] = e);
			}
			t.push(o);
		}
		o[u] = t, s[u] = r;
	}
	let d = -1;
	if (typeof r == "object" && "length" in r) for (; ++d < l;) a[d] = fS(r[d]);
	else {
		let e = fS(r);
		for (; ++d < l;) a[d] = e;
	}
	d = -1;
	let f = [], p = [];
	for (; ++d < l;) {
		let e = a[d], t = "", r = "";
		e === 99 ? (t = ":", r = ":") : e === 108 ? t = ":" : e === 114 && (r = ":");
		let i = n.alignDelimiters === !1 ? 1 : Math.max(1, c[d] - t.length - r.length), o = t + "-".repeat(i) + r;
		n.alignDelimiters !== !1 && (i = t.length + i + r.length, i > c[d] && (c[d] = i), p[d] = i), f[d] = o;
	}
	o.splice(1, 0, f), s.splice(1, 0, p), u = -1;
	let m = [];
	for (; ++u < o.length;) {
		let e = o[u], t = s[u];
		d = -1;
		let r = [];
		for (; ++d < l;) {
			let i = e[d] || "", o = "", s = "";
			if (n.alignDelimiters !== !1) {
				let e = c[d] - (t[d] || 0), n = a[d];
				n === 114 ? o = " ".repeat(e) : n === 99 ? e % 2 ? (o = " ".repeat(e / 2 + .5), s = " ".repeat(e / 2 - .5)) : (o = " ".repeat(e / 2), s = o) : s = " ".repeat(e);
			}
			n.delimiterStart !== !1 && !d && r.push("|"), n.padding !== !1 && (n.alignDelimiters !== !1 || i !== "") && (n.delimiterStart !== !1 || d) && r.push(" "), n.alignDelimiters !== !1 && r.push(o), r.push(i), n.alignDelimiters !== !1 && r.push(s), n.padding !== !1 && r.push(" "), (n.delimiterEnd !== !1 || d !== l - 1) && r.push("|");
		}
		m.push(n.delimiterEnd === !1 ? r.join("").replace(/ +$/, "") : r.join(""));
	}
	return m.join("\n");
}
function dS(e) {
	return e == null ? "" : String(e);
}
function fS(e) {
	let t = typeof e == "string" ? e.codePointAt(0) : 0;
	return t === 67 || t === 99 ? 99 : t === 76 || t === 108 ? 108 : t === 82 || t === 114 ? 114 : 0;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/blockquote.js
function pS(e, t, n, r) {
	let i = n.enter("blockquote"), a = n.createTracker(r);
	a.move("> "), a.shift(2);
	let o = n.indentLines(n.containerFlow(e, a.current()), mS);
	return i(), o;
}
function mS(e, t, n) {
	return ">" + (n ? "" : " ") + e;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/pattern-in-scope.js
function hS(e, t) {
	return gS(e, t.inConstruct, !0) && !gS(e, t.notInConstruct, !1);
}
function gS(e, t, n) {
	if (typeof t == "string" && (t = [t]), !t || t.length === 0) return n;
	let r = -1;
	for (; ++r < t.length;) if (e.includes(t[r])) return !0;
	return !1;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/break.js
function _S(e, t, n, r) {
	let i = -1;
	for (; ++i < n.unsafe.length;) if (n.unsafe[i].character === "\n" && hS(n.stack, n.unsafe[i])) return /[ \t]/.test(r.before) ? "" : " ";
	return "\\\n";
}
//#endregion
//#region node_modules/longest-streak/index.js
function vS(e, t) {
	let n = String(e), r = n.indexOf(t), i = r, a = 0, o = 0;
	if (typeof t != "string") throw TypeError("Expected substring");
	for (; r !== -1;) r === i ? ++a > o && (o = a) : a = 1, i = r + t.length, r = n.indexOf(t, i);
	return o;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/format-code-as-indented.js
function yS(e, t) {
	return !(t.options.fences !== !1 || !e.value || e.lang || !/[^ \r\n]/.test(e.value) || /^[\t ]*(?:[\r\n]|$)|(?:^|[\r\n])[\t ]*$/.test(e.value));
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-fence.js
function bS(e) {
	let t = e.options.fence || "`";
	if (t !== "`" && t !== "~") throw Error("Cannot serialize code with `" + t + "` for `options.fence`, expected `` ` `` or `~`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/code.js
function xS(e, t, n, r) {
	let i = bS(n), a = e.value || "", o = i === "`" ? "GraveAccent" : "Tilde";
	if (yS(e, n)) {
		let e = n.enter("codeIndented"), t = n.indentLines(a, SS);
		return e(), t;
	}
	let s = n.createTracker(r), c = i.repeat(Math.max(vS(a, i) + 1, 3)), l = n.enter("codeFenced"), u = s.move(c);
	if (e.lang) {
		let t = n.enter(`codeFencedLang${o}`);
		u += s.move(n.safe(e.lang, {
			before: u,
			after: " ",
			encode: ["`"],
			...s.current()
		})), t();
	}
	if (e.lang && e.meta) {
		let t = n.enter(`codeFencedMeta${o}`);
		u += s.move(" "), u += s.move(n.safe(e.meta, {
			before: u,
			after: "\n",
			encode: ["`"],
			...s.current()
		})), t();
	}
	return u += s.move("\n"), a && (u += s.move(a + "\n")), u += s.move(c), l(), u;
}
function SS(e, t, n) {
	return (n ? "" : "    ") + e;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-quote.js
function CS(e) {
	let t = e.options.quote || "\"";
	if (t !== "\"" && t !== "'") throw Error("Cannot serialize title with `" + t + "` for `options.quote`, expected `\"`, or `'`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/definition.js
function wS(e, t, n, r) {
	let i = CS(n), a = i === "\"" ? "Quote" : "Apostrophe", o = n.enter("definition"), s = n.enter("label"), c = n.createTracker(r), l = c.move("[");
	return l += c.move(n.safe(n.associationId(e), {
		before: l,
		after: "]",
		...c.current()
	})), l += c.move("]: "), s(), !e.url || /[\0- \u007F]/.test(e.url) ? (s = n.enter("destinationLiteral"), l += c.move("<"), l += c.move(n.safe(e.url, {
		before: l,
		after: ">",
		...c.current()
	})), l += c.move(">")) : (s = n.enter("destinationRaw"), l += c.move(n.safe(e.url, {
		before: l,
		after: e.title ? " " : "\n",
		...c.current()
	}))), s(), e.title && (s = n.enter(`title${a}`), l += c.move(" " + i), l += c.move(n.safe(e.title, {
		before: l,
		after: i,
		...c.current()
	})), l += c.move(i), s()), o(), l;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-emphasis.js
function TS(e) {
	let t = e.options.emphasis || "*";
	if (t !== "*" && t !== "_") throw Error("Cannot serialize emphasis with `" + t + "` for `options.emphasis`, expected `*`, or `_`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/encode-character-reference.js
function ES(e) {
	return "&#x" + e.toString(16).toUpperCase() + ";";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/encode-info.js
function DS(e, t, n) {
	let r = Ng(e), i = Ng(t);
	return r === void 0 ? i === void 0 ? n === "_" ? {
		inside: !0,
		outside: !0
	} : {
		inside: !1,
		outside: !1
	} : i === 1 ? {
		inside: !0,
		outside: !0
	} : {
		inside: !1,
		outside: !0
	} : r === 1 ? i === void 0 ? {
		inside: !1,
		outside: !1
	} : i === 1 ? {
		inside: !0,
		outside: !0
	} : {
		inside: !1,
		outside: !1
	} : i === void 0 ? {
		inside: !1,
		outside: !1
	} : i === 1 ? {
		inside: !0,
		outside: !1
	} : {
		inside: !1,
		outside: !1
	};
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/emphasis.js
OS.peek = kS;
function OS(e, t, n, r) {
	let i = TS(n), a = n.enter("emphasis"), o = n.createTracker(r), s = o.move(i), c = o.move(n.containerPhrasing(e, {
		after: i,
		before: s,
		...o.current()
	})), l = c.charCodeAt(0), u = DS(r.before.charCodeAt(r.before.length - 1), l, i);
	u.inside && (c = ES(l) + c.slice(1));
	let d = c.charCodeAt(c.length - 1), f = DS(r.after.charCodeAt(0), d, i);
	f.inside && (c = c.slice(0, -1) + ES(d));
	let p = o.move(i);
	return a(), n.attentionEncodeSurroundingInfo = {
		after: f.outside,
		before: u.outside
	}, s + c + p;
}
function kS(e, t, n) {
	return n.options.emphasis || "*";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/format-heading-as-setext.js
function AS(e, t) {
	let n = !1;
	return ab(e, function(e) {
		if ("value" in e && /\r?\n|\r/.test(e.value) || e.type === "break") return n = !0, !1;
	}), !!((!e.depth || e.depth < 3) && tg(e) && (t.options.setext || n));
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/heading.js
function jS(e, t, n, r) {
	let i = Math.max(Math.min(6, e.depth || 1), 1), a = n.createTracker(r);
	if (AS(e, n)) {
		let t = n.enter("headingSetext"), r = n.enter("phrasing"), o = n.containerPhrasing(e, {
			...a.current(),
			before: "\n",
			after: "\n"
		});
		return r(), t(), o + "\n" + (i === 1 ? "=" : "-").repeat(o.length - (Math.max(o.lastIndexOf("\r"), o.lastIndexOf("\n")) + 1));
	}
	let o = "#".repeat(i), s = n.enter("headingAtx"), c = n.enter("phrasing");
	a.move(o + " ");
	let l = n.containerPhrasing(e, {
		before: "# ",
		after: "\n",
		...a.current()
	});
	return /^[\t ]/.test(l) && (l = ES(l.charCodeAt(0)) + l.slice(1)), l = l ? o + " " + l : o, n.options.closeAtx && (l += " " + o), c(), s(), l;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/html.js
MS.peek = NS;
function MS(e) {
	return e.value || "";
}
function NS() {
	return "<";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/image.js
PS.peek = FS;
function PS(e, t, n, r) {
	let i = CS(n), a = i === "\"" ? "Quote" : "Apostrophe", o = n.enter("image"), s = n.enter("label"), c = n.createTracker(r), l = c.move("![");
	return l += c.move(n.safe(e.alt, {
		before: l,
		after: "]",
		...c.current()
	})), l += c.move("]("), s(), !e.url && e.title || /[\0- \u007F]/.test(e.url) ? (s = n.enter("destinationLiteral"), l += c.move("<"), l += c.move(n.safe(e.url, {
		before: l,
		after: ">",
		...c.current()
	})), l += c.move(">")) : (s = n.enter("destinationRaw"), l += c.move(n.safe(e.url, {
		before: l,
		after: e.title ? " " : ")",
		...c.current()
	}))), s(), e.title && (s = n.enter(`title${a}`), l += c.move(" " + i), l += c.move(n.safe(e.title, {
		before: l,
		after: i,
		...c.current()
	})), l += c.move(i), s()), l += c.move(")"), o(), l;
}
function FS() {
	return "!";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/image-reference.js
IS.peek = LS;
function IS(e, t, n, r) {
	let i = e.referenceType, a = n.enter("imageReference"), o = n.enter("label"), s = n.createTracker(r), c = s.move("!["), l = n.safe(e.alt, {
		before: c,
		after: "]",
		...s.current()
	});
	c += s.move(l + "]["), o();
	let u = n.stack;
	n.stack = [], o = n.enter("reference");
	let d = n.safe(n.associationId(e), {
		before: c,
		after: "]",
		...s.current()
	});
	return o(), n.stack = u, a(), i === "full" || !l || l !== d ? c += s.move(d + "]") : i === "shortcut" ? c = c.slice(0, -1) : c += s.move("]"), c;
}
function LS() {
	return "!";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/inline-code.js
RS.peek = zS;
function RS(e, t, n) {
	let r = e.value || "", i = "`", a = -1;
	for (; RegExp("(^|[^`])" + i + "([^`]|$)").test(r);) i += "`";
	for (/[^ \r\n]/.test(r) && (/^[ \r\n]/.test(r) && /[ \r\n]$/.test(r) || /^`|`$/.test(r)) && (r = " " + r + " "); ++a < n.unsafe.length;) {
		let e = n.unsafe[a], t = n.compilePattern(e), i;
		if (e.atBreak) for (; i = t.exec(r);) {
			let e = i.index;
			r.charCodeAt(e) === 10 && r.charCodeAt(e - 1) === 13 && e--, r = r.slice(0, e) + " " + r.slice(i.index + 1);
		}
	}
	return i + r + i;
}
function zS() {
	return "`";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/format-link-as-autolink.js
function BS(e, t) {
	let n = tg(e);
	return !(t.options.resourceLink || !e.url || e.title || !e.children || e.children.length !== 1 || e.children[0].type !== "text" || n !== e.url && "mailto:" + n !== e.url || !/^[a-z][a-z+.-]+:/i.test(e.url) || /[\0- <>\u007F]/.test(e.url));
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/link.js
VS.peek = HS;
function VS(e, t, n, r) {
	let i = CS(n), a = i === "\"" ? "Quote" : "Apostrophe", o = n.createTracker(r), s, c;
	if (BS(e, n)) {
		let t = n.stack;
		n.stack = [], s = n.enter("autolink");
		let r = o.move("<");
		return r += o.move(n.containerPhrasing(e, {
			before: r,
			after: ">",
			...o.current()
		})), r += o.move(">"), s(), n.stack = t, r;
	}
	s = n.enter("link"), c = n.enter("label");
	let l = o.move("[");
	return l += o.move(n.containerPhrasing(e, {
		before: l,
		after: "](",
		...o.current()
	})), l += o.move("]("), c(), !e.url && e.title || /[\0- \u007F]/.test(e.url) ? (c = n.enter("destinationLiteral"), l += o.move("<"), l += o.move(n.safe(e.url, {
		before: l,
		after: ">",
		...o.current()
	})), l += o.move(">")) : (c = n.enter("destinationRaw"), l += o.move(n.safe(e.url, {
		before: l,
		after: e.title ? " " : ")",
		...o.current()
	}))), c(), e.title && (c = n.enter(`title${a}`), l += o.move(" " + i), l += o.move(n.safe(e.title, {
		before: l,
		after: i,
		...o.current()
	})), l += o.move(i), c()), l += o.move(")"), s(), l;
}
function HS(e, t, n) {
	return BS(e, n) ? "<" : "[";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/link-reference.js
US.peek = WS;
function US(e, t, n, r) {
	let i = e.referenceType, a = n.enter("linkReference"), o = n.enter("label"), s = n.createTracker(r), c = s.move("["), l = n.containerPhrasing(e, {
		before: c,
		after: "]",
		...s.current()
	});
	c += s.move(l + "]["), o();
	let u = n.stack;
	n.stack = [], o = n.enter("reference");
	let d = n.safe(n.associationId(e), {
		before: c,
		after: "]",
		...s.current()
	});
	return o(), n.stack = u, a(), i === "full" || !l || l !== d ? c += s.move(d + "]") : i === "shortcut" ? c = c.slice(0, -1) : c += s.move("]"), c;
}
function WS() {
	return "[";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-bullet.js
function GS(e) {
	let t = e.options.bullet || "*";
	if (t !== "*" && t !== "+" && t !== "-") throw Error("Cannot serialize items with `" + t + "` for `options.bullet`, expected `*`, `+`, or `-`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-bullet-other.js
function KS(e) {
	let t = GS(e), n = e.options.bulletOther;
	if (!n) return t === "*" ? "-" : "*";
	if (n !== "*" && n !== "+" && n !== "-") throw Error("Cannot serialize items with `" + n + "` for `options.bulletOther`, expected `*`, `+`, or `-`");
	if (n === t) throw Error("Expected `bullet` (`" + t + "`) and `bulletOther` (`" + n + "`) to be different");
	return n;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-bullet-ordered.js
function qS(e) {
	let t = e.options.bulletOrdered || ".";
	if (t !== "." && t !== ")") throw Error("Cannot serialize items with `" + t + "` for `options.bulletOrdered`, expected `.` or `)`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-rule.js
function JS(e) {
	let t = e.options.rule || "*";
	if (t !== "*" && t !== "-" && t !== "_") throw Error("Cannot serialize rules with `" + t + "` for `options.rule`, expected `*`, `-`, or `_`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/list.js
function YS(e, t, n, r) {
	let i = n.enter("list"), a = n.bulletCurrent, o = e.ordered ? qS(n) : GS(n), s = e.ordered ? o === "." ? ")" : "." : KS(n), c = t && n.bulletLastUsed ? o === n.bulletLastUsed : !1;
	if (!e.ordered) {
		let t = e.children ? e.children[0] : void 0;
		if ((o === "*" || o === "-") && t && (!t.children || !t.children[0]) && n.stack[n.stack.length - 1] === "list" && n.stack[n.stack.length - 2] === "listItem" && n.stack[n.stack.length - 3] === "list" && n.stack[n.stack.length - 4] === "listItem" && n.indexStack[n.indexStack.length - 1] === 0 && n.indexStack[n.indexStack.length - 2] === 0 && n.indexStack[n.indexStack.length - 3] === 0 && (c = !0), JS(n) === o && t) {
			let t = -1;
			for (; ++t < e.children.length;) {
				let n = e.children[t];
				if (n && n.type === "listItem" && n.children && n.children[0] && n.children[0].type === "thematicBreak") {
					c = !0;
					break;
				}
			}
		}
	}
	c && (o = s), n.bulletCurrent = o;
	let l = n.containerFlow(e, r);
	return n.bulletLastUsed = o, n.bulletCurrent = a, i(), l;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-list-item-indent.js
function XS(e) {
	let t = e.options.listItemIndent || "one";
	if (t !== "tab" && t !== "one" && t !== "mixed") throw Error("Cannot serialize items with `" + t + "` for `options.listItemIndent`, expected `tab`, `one`, or `mixed`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/list-item.js
function ZS(e, t, n, r) {
	let i = XS(n), a = n.bulletCurrent || GS(n);
	t && t.type === "list" && t.ordered && (a = (typeof t.start == "number" && t.start > -1 ? t.start : 1) + (n.options.incrementListMarker === !1 ? 0 : t.children.indexOf(e)) + a);
	let o = a.length + 1;
	(i === "tab" || i === "mixed" && (t && t.type === "list" && t.spread || e.spread)) && (o = Math.ceil(o / 4) * 4);
	let s = n.createTracker(r);
	s.move(a + " ".repeat(o - a.length)), s.shift(o);
	let c = n.enter("listItem"), l = n.indentLines(n.containerFlow(e, s.current()), u);
	return c(), l;
	function u(e, t, n) {
		return t ? (n ? "" : " ".repeat(o)) + e : (n ? a : a + " ".repeat(o - a.length)) + e;
	}
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/paragraph.js
function QS(e, t, n, r) {
	let i = n.enter("paragraph"), a = n.enter("phrasing"), o = n.containerPhrasing(e, r);
	return a(), i(), o;
}
//#endregion
//#region node_modules/mdast-util-phrasing/lib/index.js
var $S = Jy([
	"break",
	"delete",
	"emphasis",
	"footnote",
	"footnoteReference",
	"image",
	"imageReference",
	"inlineCode",
	"inlineMath",
	"link",
	"linkReference",
	"mdxJsxTextElement",
	"mdxTextExpression",
	"strong",
	"text",
	"textDirective"
]);
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/root.js
function eC(e, t, n, r) {
	return (e.children.some(function(e) {
		return $S(e);
	}) ? n.containerPhrasing : n.containerFlow).call(n, e, r);
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-strong.js
function tC(e) {
	let t = e.options.strong || "*";
	if (t !== "*" && t !== "_") throw Error("Cannot serialize strong with `" + t + "` for `options.strong`, expected `*`, or `_`");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/strong.js
nC.peek = rC;
function nC(e, t, n, r) {
	let i = tC(n), a = n.enter("strong"), o = n.createTracker(r), s = o.move(i + i), c = o.move(n.containerPhrasing(e, {
		after: i,
		before: s,
		...o.current()
	})), l = c.charCodeAt(0), u = DS(r.before.charCodeAt(r.before.length - 1), l, i);
	u.inside && (c = ES(l) + c.slice(1));
	let d = c.charCodeAt(c.length - 1), f = DS(r.after.charCodeAt(0), d, i);
	f.inside && (c = c.slice(0, -1) + ES(d));
	let p = o.move(i + i);
	return a(), n.attentionEncodeSurroundingInfo = {
		after: f.outside,
		before: u.outside
	}, s + c + p;
}
function rC(e, t, n) {
	return n.options.strong || "*";
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/text.js
function iC(e, t, n, r) {
	return n.safe(e.value, r);
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/util/check-rule-repetition.js
function aC(e) {
	let t = e.options.ruleRepetition || 3;
	if (t < 3) throw Error("Cannot serialize rules with repetition `" + t + "` for `options.ruleRepetition`, expected `3` or more");
	return t;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/thematic-break.js
function oC(e, t, n) {
	let r = (JS(n) + (n.options.ruleSpaces ? " " : "")).repeat(aC(n));
	return n.options.ruleSpaces ? r.slice(0, -1) : r;
}
//#endregion
//#region node_modules/mdast-util-to-markdown/lib/handle/index.js
var sC = {
	blockquote: pS,
	break: _S,
	code: xS,
	definition: wS,
	emphasis: OS,
	hardBreak: _S,
	heading: jS,
	html: MS,
	image: PS,
	imageReference: IS,
	inlineCode: RS,
	link: VS,
	linkReference: US,
	list: YS,
	listItem: ZS,
	paragraph: QS,
	root: eC,
	strong: nC,
	text: iC,
	thematicBreak: oC
};
//#endregion
//#region node_modules/mdast-util-gfm-table/lib/index.js
function cC() {
	return {
		enter: {
			table: lC,
			tableData: pC,
			tableHeader: pC,
			tableRow: dC
		},
		exit: {
			codeText: mC,
			table: uC,
			tableData: fC,
			tableHeader: fC,
			tableRow: fC
		}
	};
}
function lC(e) {
	let t = e._align;
	this.enter({
		type: "table",
		align: t.map(function(e) {
			return e === "none" ? null : e;
		}),
		children: []
	}, e), this.data.inTable = !0;
}
function uC(e) {
	this.exit(e), this.data.inTable = void 0;
}
function dC(e) {
	this.enter({
		type: "tableRow",
		children: []
	}, e);
}
function fC(e) {
	this.exit(e);
}
function pC(e) {
	this.enter({
		type: "tableCell",
		children: []
	}, e);
}
function mC(e) {
	let t = this.resume();
	this.data.inTable && (t = t.replace(/\\([\\|])/g, hC));
	let n = this.stack[this.stack.length - 1];
	n.type, n.value = t, this.exit(e);
}
function hC(e, t) {
	return t === "|" ? t : e;
}
function gC(e) {
	let t = e || {}, n = t.tableCellPadding, r = t.tablePipeAlign, i = t.stringLength, a = n ? " " : "|";
	return {
		unsafe: [
			{
				character: "\r",
				inConstruct: "tableCell"
			},
			{
				character: "\n",
				inConstruct: "tableCell"
			},
			{
				atBreak: !0,
				character: "|",
				after: "[	 :-]"
			},
			{
				character: "|",
				inConstruct: "tableCell"
			},
			{
				atBreak: !0,
				character: ":",
				after: "-"
			},
			{
				atBreak: !0,
				character: "-",
				after: "[:|-]"
			}
		],
		handlers: {
			inlineCode: f,
			table: o,
			tableCell: c,
			tableRow: s
		}
	};
	function o(e, t, n, r) {
		return l(u(e, n, r), e.align);
	}
	function s(e, t, n, r) {
		let i = l([d(e, n, r)]);
		return i.slice(0, i.indexOf("\n"));
	}
	function c(e, t, n, r) {
		let i = n.enter("tableCell"), o = n.enter("phrasing"), s = n.containerPhrasing(e, {
			...r,
			before: a,
			after: a
		});
		return o(), i(), s;
	}
	function l(e, t) {
		return uS(e, {
			align: t,
			alignDelimiters: r,
			padding: n,
			stringLength: i
		});
	}
	function u(e, t, n) {
		let r = e.children, i = -1, a = [], o = t.enter("table");
		for (; ++i < r.length;) a[i] = d(r[i], t, n);
		return o(), a;
	}
	function d(e, t, n) {
		let r = e.children, i = -1, a = [], o = t.enter("tableRow");
		for (; ++i < r.length;) a[i] = c(r[i], e, t, n);
		return o(), a;
	}
	function f(e, t, n) {
		let r = sC.inlineCode(e, t, n);
		return n.stack.includes("tableCell") && (r = r.replace(/\|/g, "\\$&")), r;
	}
}
//#endregion
//#region node_modules/mdast-util-gfm-task-list-item/lib/index.js
function _C() {
	return { exit: {
		taskListCheckValueChecked: yC,
		taskListCheckValueUnchecked: yC,
		paragraph: bC
	} };
}
function vC() {
	return {
		unsafe: [{
			atBreak: !0,
			character: "-",
			after: "[:|-]"
		}],
		handlers: { listItem: xC }
	};
}
function yC(e) {
	let t = this.stack[this.stack.length - 2];
	t.type, t.checked = e.type === "taskListCheckValueChecked";
}
function bC(e) {
	let t = this.stack[this.stack.length - 2];
	if (t && t.type === "listItem" && typeof t.checked == "boolean") {
		let e = this.stack[this.stack.length - 1];
		e.type;
		let n = e.children[0];
		if (n && n.type === "text") {
			let r = t.children, i = -1, a;
			for (; ++i < r.length;) {
				let e = r[i];
				if (e.type === "paragraph") {
					a = e;
					break;
				}
			}
			a === e && (n.value = n.value.slice(1), n.value.length === 0 ? e.children.shift() : e.position && n.position && typeof n.position.start.offset == "number" && (n.position.start.column++, n.position.start.offset++, e.position.start = Object.assign({}, n.position.start)));
		}
	}
	this.exit(e);
}
function xC(e, t, n, r) {
	let i = e.children[0], a = typeof e.checked == "boolean" && i && i.type === "paragraph", o = "[" + (e.checked ? "x" : " ") + "] ", s = n.createTracker(r);
	a && s.move(o);
	let c = sC.listItem(e, t, n, {
		...r,
		...s.current()
	});
	return a && (c = c.replace(/^(?:[*+-]|\d+\.)([\r\n]| {1,3})/, l)), c;
	function l(e) {
		return e + o;
	}
}
//#endregion
//#region node_modules/mdast-util-gfm/lib/index.js
function SC() {
	return [
		Ox(),
		Qx(),
		rS(),
		cC(),
		_C()
	];
}
function CC(e) {
	return { extensions: [
		kx(),
		$x(e),
		iS(),
		gC(e),
		vC()
	] };
}
//#endregion
//#region node_modules/micromark-extension-gfm-autolink-literal/lib/syntax.js
var wC = {
	tokenize: RC,
	partial: !0
}, TC = {
	tokenize: zC,
	partial: !0
}, EC = {
	tokenize: BC,
	partial: !0
}, DC = {
	tokenize: VC,
	partial: !0
}, OC = {
	tokenize: HC,
	partial: !0
}, kC = {
	name: "wwwAutolink",
	tokenize: IC,
	previous: UC
}, AC = {
	name: "protocolAutolink",
	tokenize: LC,
	previous: WC
}, jC = {
	name: "emailAutolink",
	tokenize: FC,
	previous: GC
}, MC = {};
function NC() {
	return { text: MC };
}
for (var PC = 48; PC < 123;) MC[PC] = jC, PC++, PC === 58 ? PC = 65 : PC === 91 && (PC = 97);
MC[43] = jC, MC[45] = jC, MC[46] = jC, MC[95] = jC, MC[72] = [jC, AC], MC[104] = [jC, AC], MC[87] = [jC, kC], MC[119] = [jC, kC];
function FC(e, t, n) {
	let r = this, i, a;
	return o;
	function o(t) {
		return !KC(t) || !GC.call(r, r.previous) || qC(r.events) ? n(t) : (e.enter("literalAutolink"), e.enter("literalAutolinkEmail"), s(t));
	}
	function s(t) {
		return KC(t) ? (e.consume(t), s) : t === 64 ? (e.consume(t), c) : n(t);
	}
	function c(t) {
		return t === 46 ? e.check(OC, u, l)(t) : t === 45 || t === 95 || gg(t) ? (a = !0, e.consume(t), c) : u(t);
	}
	function l(t) {
		return e.consume(t), i = !0, c;
	}
	function u(o) {
		return a && i && hg(r.previous) ? (e.exit("literalAutolinkEmail"), e.exit("literalAutolink"), t(o)) : n(o);
	}
}
function IC(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return t !== 87 && t !== 119 || !UC.call(r, r.previous) || qC(r.events) ? n(t) : (e.enter("literalAutolink"), e.enter("literalAutolinkWww"), e.check(wC, e.attempt(TC, e.attempt(EC, a), n), n)(t));
	}
	function a(n) {
		return e.exit("literalAutolinkWww"), e.exit("literalAutolink"), t(n);
	}
}
function LC(e, t, n) {
	let r = this, i = "", a = !1;
	return o;
	function o(t) {
		return (t === 72 || t === 104) && WC.call(r, r.previous) && !qC(r.events) ? (e.enter("literalAutolink"), e.enter("literalAutolinkHttp"), i += String.fromCodePoint(t), e.consume(t), s) : n(t);
	}
	function s(t) {
		if (hg(t) && i.length < 5) return i += String.fromCodePoint(t), e.consume(t), s;
		if (t === 58) {
			let n = i.toLowerCase();
			if (n === "http" || n === "https") return e.consume(t), c;
		}
		return n(t);
	}
	function c(t) {
		return t === 47 ? (e.consume(t), a ? l : (a = !0, c)) : n(t);
	}
	function l(t) {
		return t === null || vg(t) || Sg(t) || wg(t) || Cg(t) ? n(t) : e.attempt(TC, e.attempt(EC, u), n)(t);
	}
	function u(n) {
		return e.exit("literalAutolinkHttp"), e.exit("literalAutolink"), t(n);
	}
}
function RC(e, t, n) {
	let r = 0;
	return i;
	function i(t) {
		return (t === 87 || t === 119) && r < 3 ? (r++, e.consume(t), i) : t === 46 && r === 3 ? (e.consume(t), a) : n(t);
	}
	function a(e) {
		return e === null ? n(e) : t(e);
	}
}
function zC(e, t, n) {
	let r, i, a;
	return o;
	function o(t) {
		return t === 46 || t === 95 ? e.check(DC, c, s)(t) : t === null || Sg(t) || wg(t) || t !== 45 && Cg(t) ? c(t) : (a = !0, e.consume(t), o);
	}
	function s(t) {
		return t === 95 ? r = !0 : (i = r, r = void 0), e.consume(t), o;
	}
	function c(e) {
		return i || r || !a ? n(e) : t(e);
	}
}
function BC(e, t) {
	let n = 0, r = 0;
	return i;
	function i(o) {
		return o === 40 ? (n++, e.consume(o), i) : o === 41 && r < n ? a(o) : o === 33 || o === 34 || o === 38 || o === 39 || o === 41 || o === 42 || o === 44 || o === 46 || o === 58 || o === 59 || o === 60 || o === 63 || o === 93 || o === 95 || o === 126 ? e.check(DC, t, a)(o) : o === null || Sg(o) || wg(o) ? t(o) : (e.consume(o), i);
	}
	function a(t) {
		return t === 41 && r++, e.consume(t), i;
	}
}
function VC(e, t, n) {
	return r;
	function r(o) {
		return o === 33 || o === 34 || o === 39 || o === 41 || o === 42 || o === 44 || o === 46 || o === 58 || o === 59 || o === 63 || o === 95 || o === 126 ? (e.consume(o), r) : o === 38 ? (e.consume(o), a) : o === 93 ? (e.consume(o), i) : o === 60 || o === null || Sg(o) || wg(o) ? t(o) : n(o);
	}
	function i(e) {
		return e === null || e === 40 || e === 91 || Sg(e) || wg(e) ? t(e) : r(e);
	}
	function a(e) {
		return hg(e) ? o(e) : n(e);
	}
	function o(t) {
		return t === 59 ? (e.consume(t), r) : hg(t) ? (e.consume(t), o) : n(t);
	}
}
function HC(e, t, n) {
	return r;
	function r(t) {
		return e.consume(t), i;
	}
	function i(e) {
		return gg(e) ? n(e) : t(e);
	}
}
function UC(e) {
	return e === null || e === 40 || e === 42 || e === 95 || e === 91 || e === 93 || e === 126 || Sg(e);
}
function WC(e) {
	return !hg(e);
}
function GC(e) {
	return !(e === 47 || KC(e));
}
function KC(e) {
	return e === 43 || e === 45 || e === 46 || e === 95 || gg(e);
}
function qC(e) {
	let t = e.length, n = !1;
	for (; t--;) {
		let r = e[t][1];
		if ((r.type === "labelLink" || r.type === "labelImage") && !r._balanced) {
			n = !0;
			break;
		}
		if (r._gfmAutolinkLiteralWalkedInto) {
			n = !1;
			break;
		}
	}
	return e.length > 0 && !n && (e[e.length - 1][1]._gfmAutolinkLiteralWalkedInto = !0), n;
}
//#endregion
//#region node_modules/micromark-extension-gfm-footnote/lib/syntax.js
var JC = {
	tokenize: nw,
	partial: !0
};
function YC() {
	return {
		document: { 91: {
			name: "gfmFootnoteDefinition",
			tokenize: $C,
			continuation: { tokenize: ew },
			exit: tw
		} },
		text: {
			91: {
				name: "gfmFootnoteCall",
				tokenize: QC
			},
			93: {
				name: "gfmPotentialFootnoteCall",
				add: "after",
				tokenize: XC,
				resolveTo: ZC
			}
		}
	};
}
function XC(e, t, n) {
	let r = this, i = r.events.length, a = r.parser.gfmFootnotes || (r.parser.gfmFootnotes = []), o;
	for (; i--;) {
		let e = r.events[i][1];
		if (e.type === "labelImage") {
			o = e;
			break;
		}
		if (e.type === "gfmFootnoteCall" || e.type === "labelLink" || e.type === "label" || e.type === "image" || e.type === "link") break;
	}
	return s;
	function s(i) {
		if (!o || !o._balanced) return n(i);
		let s = mg(r.sliceSerialize({
			start: o.end,
			end: r.now()
		}));
		return s.codePointAt(0) !== 94 || !a.includes(s.slice(1)) ? n(i) : (e.enter("gfmFootnoteCallLabelMarker"), e.consume(i), e.exit("gfmFootnoteCallLabelMarker"), t(i));
	}
}
function ZC(e, t) {
	let n = e.length;
	for (; n--;) if (e[n][1].type === "labelImage" && e[n][0] === "enter") {
		e[n][1];
		break;
	}
	e[n + 1][1].type = "data", e[n + 3][1].type = "gfmFootnoteCallLabelMarker";
	let r = {
		type: "gfmFootnoteCall",
		start: Object.assign({}, e[n + 3][1].start),
		end: Object.assign({}, e[e.length - 1][1].end)
	}, i = {
		type: "gfmFootnoteCallMarker",
		start: Object.assign({}, e[n + 3][1].end),
		end: Object.assign({}, e[n + 3][1].end)
	};
	i.end.column++, i.end.offset++, i.end._bufferIndex++;
	let a = {
		type: "gfmFootnoteCallString",
		start: Object.assign({}, i.end),
		end: Object.assign({}, e[e.length - 1][1].start)
	}, o = {
		type: "chunkString",
		contentType: "string",
		start: Object.assign({}, a.start),
		end: Object.assign({}, a.end)
	}, s = [
		e[n + 1],
		e[n + 2],
		[
			"enter",
			r,
			t
		],
		e[n + 3],
		e[n + 4],
		[
			"enter",
			i,
			t
		],
		[
			"exit",
			i,
			t
		],
		[
			"enter",
			a,
			t
		],
		[
			"enter",
			o,
			t
		],
		[
			"exit",
			o,
			t
		],
		[
			"exit",
			a,
			t
		],
		e[e.length - 2],
		e[e.length - 1],
		[
			"exit",
			r,
			t
		]
	];
	return e.splice(n, e.length - n + 1, ...s), e;
}
function QC(e, t, n) {
	let r = this, i = r.parser.gfmFootnotes || (r.parser.gfmFootnotes = []), a = 0, o;
	return s;
	function s(t) {
		return e.enter("gfmFootnoteCall"), e.enter("gfmFootnoteCallLabelMarker"), e.consume(t), e.exit("gfmFootnoteCallLabelMarker"), c;
	}
	function c(t) {
		return t === 94 ? (e.enter("gfmFootnoteCallMarker"), e.consume(t), e.exit("gfmFootnoteCallMarker"), e.enter("gfmFootnoteCallString"), e.enter("chunkString").contentType = "string", l) : n(t);
	}
	function l(s) {
		if (a > 999 || s === 93 && !o || s === null || s === 91 || Sg(s)) return n(s);
		if (s === 93) {
			e.exit("chunkString");
			let a = e.exit("gfmFootnoteCallString");
			return i.includes(mg(r.sliceSerialize(a))) ? (e.enter("gfmFootnoteCallLabelMarker"), e.consume(s), e.exit("gfmFootnoteCallLabelMarker"), e.exit("gfmFootnoteCall"), t) : n(s);
		}
		return Sg(s) || (o = !0), a++, e.consume(s), s === 92 ? u : l;
	}
	function u(t) {
		return t === 91 || t === 92 || t === 93 ? (e.consume(t), a++, l) : l(t);
	}
}
function $C(e, t, n) {
	let r = this, i = r.parser.gfmFootnotes || (r.parser.gfmFootnotes = []), a, o = 0, s;
	return c;
	function c(t) {
		return e.enter("gfmFootnoteDefinition")._container = !0, e.enter("gfmFootnoteDefinitionLabel"), e.enter("gfmFootnoteDefinitionLabelMarker"), e.consume(t), e.exit("gfmFootnoteDefinitionLabelMarker"), l;
	}
	function l(t) {
		return t === 94 ? (e.enter("gfmFootnoteDefinitionMarker"), e.consume(t), e.exit("gfmFootnoteDefinitionMarker"), e.enter("gfmFootnoteDefinitionLabelString"), e.enter("chunkString").contentType = "string", u) : n(t);
	}
	function u(t) {
		if (o > 999 || t === 93 && !s || t === null || t === 91 || Sg(t)) return n(t);
		if (t === 93) {
			e.exit("chunkString");
			let n = e.exit("gfmFootnoteDefinitionLabelString");
			return a = mg(r.sliceSerialize(n)), e.enter("gfmFootnoteDefinitionLabelMarker"), e.consume(t), e.exit("gfmFootnoteDefinitionLabelMarker"), e.exit("gfmFootnoteDefinitionLabel"), f;
		}
		return Sg(t) || (s = !0), o++, e.consume(t), t === 92 ? d : u;
	}
	function d(t) {
		return t === 91 || t === 92 || t === 93 ? (e.consume(t), o++, u) : u(t);
	}
	function f(t) {
		return t === 58 ? (e.enter("definitionMarker"), e.consume(t), e.exit("definitionMarker"), i.includes(a) || i.push(a), $(e, p, "gfmFootnoteDefinitionWhitespace")) : n(t);
	}
	function p(e) {
		return t(e);
	}
}
function ew(e, t, n) {
	return e.check(Vg, t, e.attempt(JC, t, n));
}
function tw(e) {
	e.exit("gfmFootnoteDefinition");
}
function nw(e, t, n) {
	let r = this;
	return $(e, i, "gfmFootnoteDefinitionIndent", 5);
	function i(e) {
		let i = r.events[r.events.length - 1];
		return i && i[1].type === "gfmFootnoteDefinitionIndent" && i[2].sliceSerialize(i[1], !0).length === 4 ? t(e) : n(e);
	}
}
//#endregion
//#region node_modules/micromark-extension-gfm-strikethrough/lib/syntax.js
function rw(e) {
	let t = (e || {}).singleTilde, n = {
		name: "strikethrough",
		tokenize: i,
		resolveAll: r
	};
	return t ??= !0, {
		text: { 126: n },
		insideSpan: { null: [n] },
		attentionMarkers: { null: [126] }
	};
	function r(e, t) {
		let n = -1;
		for (; ++n < e.length;) if (e[n][0] === "enter" && e[n][1].type === "strikethroughSequenceTemporary" && e[n][1]._close) {
			let r = n;
			for (; r--;) if (e[r][0] === "exit" && e[r][1].type === "strikethroughSequenceTemporary" && e[r][1]._open && e[n][1].end.offset - e[n][1].start.offset === e[r][1].end.offset - e[r][1].start.offset) {
				e[n][1].type = "strikethroughSequence", e[r][1].type = "strikethroughSequence";
				let i = {
					type: "strikethrough",
					start: Object.assign({}, e[r][1].start),
					end: Object.assign({}, e[n][1].end)
				}, a = {
					type: "strikethroughText",
					start: Object.assign({}, e[r][1].end),
					end: Object.assign({}, e[n][1].start)
				}, o = [
					[
						"enter",
						i,
						t
					],
					[
						"enter",
						e[r][1],
						t
					],
					[
						"exit",
						e[r][1],
						t
					],
					[
						"enter",
						a,
						t
					]
				], s = t.parser.constructs.insideSpan.null;
				s && sg(o, o.length, 0, Pg(s, e.slice(r + 1, n), t)), sg(o, o.length, 0, [
					[
						"exit",
						a,
						t
					],
					[
						"enter",
						e[n][1],
						t
					],
					[
						"exit",
						e[n][1],
						t
					],
					[
						"exit",
						i,
						t
					]
				]), sg(e, r - 1, n - r + 3, o), n = r + o.length - 2;
				break;
			}
		}
		for (n = -1; ++n < e.length;) e[n][1].type === "strikethroughSequenceTemporary" && (e[n][1].type = "data");
		return e;
	}
	function i(e, n, r) {
		let i = this.previous, a = this.events, o = 0;
		return s;
		function s(t) {
			return i === 126 && a[a.length - 1][1].type !== "characterEscape" ? r(t) : (e.enter("strikethroughSequenceTemporary"), c(t));
		}
		function c(a) {
			let s = Ng(i);
			if (a === 126) return o > 1 ? r(a) : (e.consume(a), o++, c);
			if (o < 2 && !t) return r(a);
			let l = e.exit("strikethroughSequenceTemporary"), u = Ng(a);
			return l._open = !u || u === 2 && !!s, l._close = !s || s === 2 && !!u, n(a);
		}
	}
}
//#endregion
//#region node_modules/micromark-extension-gfm-table/lib/edit-map.js
var iw = class {
	constructor() {
		this.map = [], this.index = /* @__PURE__ */ new Map();
	}
	add(e, t, n) {
		aw(this, e, t, n);
	}
	consume(e) {
		/* c8 ignore next 3 -- `resolve` is never called without tables, so without edits. */
		if (this.map.sort(function(e, t) {
			return e[0] - t[0];
		}), this.map.length === 0) return;
		let t = this.map.length, n = [];
		for (; t > 0;) --t, n.push(e.slice(this.map[t][0] + this.map[t][1]), this.map[t][2]), e.length = this.map[t][0];
		n.push(e.slice()), e.length = 0;
		let r = n.pop();
		for (; r;) {
			for (let t of r) e.push(t);
			r = n.pop();
		}
		this.map.length = 0, this.index.clear();
	}
};
function aw(e, t, n, r) {
	/* c8 ignore next 3 -- `resolve` is never called without tables, so without edits. */
	if (n === 0 && r.length === 0) return;
	let i = e.index.get(t);
	if (i) {
		i[1] += n, i[2].push(...r);
		return;
	}
	let a = [
		t,
		n,
		r
	];
	e.map.push(a), e.index.set(t, a);
}
//#endregion
//#region node_modules/micromark-extension-gfm-table/lib/infer.js
function ow(e, t) {
	let n = !1, r = [];
	for (; t < e.length;) {
		let i = e[t];
		if (n) {
			if (i[0] === "enter") i[1].type === "tableContent" && r.push(e[t + 1][1].type === "tableDelimiterMarker" ? "left" : "none");
			else if (i[1].type === "tableContent") {
				if (e[t - 1][1].type === "tableDelimiterMarker") {
					let e = r.length - 1;
					r[e] = r[e] === "left" ? "center" : "right";
				}
			} else if (i[1].type === "tableDelimiterRow") break;
		} else i[0] === "enter" && i[1].type === "tableDelimiterRow" && (n = !0);
		t += 1;
	}
	return r;
}
//#endregion
//#region node_modules/micromark-extension-gfm-table/lib/syntax.js
function sw() {
	return { flow: { null: {
		name: "table",
		tokenize: cw,
		resolveAll: lw
	} } };
}
function cw(e, t, n) {
	let r = this, i = 0, a = 0, o;
	return s;
	function s(e) {
		let t = r.events.length - 1;
		for (; t > -1;) {
			let { type: e } = r.events[t][1];
			if (e === "lineEnding" || e === "linePrefix") t--;
			else break;
		}
		let i = t > -1 ? r.events[t][1].type : null, a = i === "tableHead" || i === "tableRow" ? S : c;
		return a === S && r.parser.lazy[r.now().line] ? n(e) : a(e);
	}
	function c(t) {
		return e.enter("tableHead"), e.enter("tableRow"), l(t);
	}
	function l(e) {
		return e === 124 ? u(e) : (o = !0, a += 1, u(e));
	}
	function u(t) {
		return t === null ? n(t) : Z(t) ? a > 1 ? (a = 0, r.interrupt = !0, e.exit("tableRow"), e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), p) : n(t) : Q(t) ? $(e, u, "whitespace")(t) : (a += 1, o && (o = !1, i += 1), t === 124 ? (e.enter("tableCellDivider"), e.consume(t), e.exit("tableCellDivider"), o = !0, u) : (e.enter("data"), d(t)));
	}
	function d(t) {
		return t === null || t === 124 || Sg(t) ? (e.exit("data"), u(t)) : (e.consume(t), t === 92 ? f : d);
	}
	function f(t) {
		return t === 92 || t === 124 ? (e.consume(t), d) : d(t);
	}
	function p(t) {
		return r.interrupt = !1, r.parser.lazy[r.now().line] ? n(t) : (e.enter("tableDelimiterRow"), o = !1, Q(t) ? $(e, m, "linePrefix", r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(t) : m(t));
	}
	function m(t) {
		return t === 45 || t === 58 ? g(t) : t === 124 ? (o = !0, e.enter("tableCellDivider"), e.consume(t), e.exit("tableCellDivider"), h) : x(t);
	}
	function h(t) {
		return Q(t) ? $(e, g, "whitespace")(t) : g(t);
	}
	function g(t) {
		return t === 58 ? (a += 1, o = !0, e.enter("tableDelimiterMarker"), e.consume(t), e.exit("tableDelimiterMarker"), _) : t === 45 ? (a += 1, _(t)) : t === null || Z(t) ? b(t) : x(t);
	}
	function _(t) {
		return t === 45 ? (e.enter("tableDelimiterFiller"), v(t)) : x(t);
	}
	function v(t) {
		return t === 45 ? (e.consume(t), v) : t === 58 ? (o = !0, e.exit("tableDelimiterFiller"), e.enter("tableDelimiterMarker"), e.consume(t), e.exit("tableDelimiterMarker"), y) : (e.exit("tableDelimiterFiller"), y(t));
	}
	function y(t) {
		return Q(t) ? $(e, b, "whitespace")(t) : b(t);
	}
	function b(n) {
		return n === 124 ? m(n) : n === null || Z(n) ? !o || i !== a ? x(n) : (e.exit("tableDelimiterRow"), e.exit("tableHead"), t(n)) : x(n);
	}
	function x(e) {
		return n(e);
	}
	function S(t) {
		return e.enter("tableRow"), C(t);
	}
	function C(n) {
		return n === 124 ? (e.enter("tableCellDivider"), e.consume(n), e.exit("tableCellDivider"), C) : n === null || Z(n) ? (e.exit("tableRow"), t(n)) : Q(n) ? $(e, C, "whitespace")(n) : (e.enter("data"), w(n));
	}
	function w(t) {
		return t === null || t === 124 || Sg(t) ? (e.exit("data"), C(t)) : (e.consume(t), t === 92 ? T : w);
	}
	function T(t) {
		return t === 92 || t === 124 ? (e.consume(t), w) : w(t);
	}
}
function lw(e, t) {
	let n = -1, r = !0, i = 0, a = [
		0,
		0,
		0,
		0
	], o = [
		0,
		0,
		0,
		0
	], s = !1, c = 0, l, u, d, f = new iw();
	for (; ++n < e.length;) {
		let p = e[n], m = p[1];
		p[0] === "enter" ? m.type === "tableHead" ? (s = !1, c !== 0 && (dw(f, t, c, l, u), u = void 0, c = 0), l = {
			type: "table",
			start: Object.assign({}, m.start),
			end: Object.assign({}, m.end)
		}, f.add(n, 0, [[
			"enter",
			l,
			t
		]])) : m.type === "tableRow" || m.type === "tableDelimiterRow" ? (r = !0, d = void 0, a = [
			0,
			0,
			0,
			0
		], o = [
			0,
			n + 1,
			0,
			0
		], s && (s = !1, u = {
			type: "tableBody",
			start: Object.assign({}, m.start),
			end: Object.assign({}, m.end)
		}, f.add(n, 0, [[
			"enter",
			u,
			t
		]])), i = m.type === "tableDelimiterRow" ? 2 : u ? 3 : 1) : i && (m.type === "data" || m.type === "tableDelimiterMarker" || m.type === "tableDelimiterFiller") ? (r = !1, o[2] === 0 && (a[1] !== 0 && (o[0] = o[1], d = uw(f, t, a, i, void 0, d), a = [
			0,
			0,
			0,
			0
		]), o[2] = n)) : m.type === "tableCellDivider" && (r ? r = !1 : (a[1] !== 0 && (o[0] = o[1], d = uw(f, t, a, i, void 0, d)), a = o, o = [
			a[1],
			n,
			0,
			0
		])) : m.type === "tableHead" ? (s = !0, c = n) : m.type === "tableRow" || m.type === "tableDelimiterRow" ? (c = n, a[1] === 0 ? o[1] !== 0 && (d = uw(f, t, o, i, n, d)) : (o[0] = o[1], d = uw(f, t, a, i, n, d)), i = 0) : i && (m.type === "data" || m.type === "tableDelimiterMarker" || m.type === "tableDelimiterFiller") && (o[3] = n);
	}
	for (c !== 0 && dw(f, t, c, l, u), f.consume(t.events), n = -1; ++n < t.events.length;) {
		let e = t.events[n];
		e[0] === "enter" && e[1].type === "table" && (e[1]._align = ow(t.events, n));
	}
	return e;
}
function uw(e, t, n, r, i, a) {
	let o = r === 1 ? "tableHeader" : r === 2 ? "tableDelimiter" : "tableData";
	n[0] !== 0 && (a.end = Object.assign({}, fw(t.events, n[0])), e.add(n[0], 0, [[
		"exit",
		a,
		t
	]]));
	let s = fw(t.events, n[1]);
	if (a = {
		type: o,
		start: Object.assign({}, s),
		end: Object.assign({}, s)
	}, e.add(n[1], 0, [[
		"enter",
		a,
		t
	]]), n[2] !== 0) {
		let i = fw(t.events, n[2]), a = fw(t.events, n[3]), o = {
			type: "tableContent",
			start: Object.assign({}, i),
			end: Object.assign({}, a)
		};
		if (e.add(n[2], 0, [[
			"enter",
			o,
			t
		]]), r !== 2) {
			let r = t.events[n[2]], i = t.events[n[3]];
			if (r[1].end = Object.assign({}, i[1].end), r[1].type = "chunkText", r[1].contentType = "text", n[3] > n[2] + 1) {
				let t = n[2] + 1, r = n[3] - n[2] - 1;
				e.add(t, r, []);
			}
		}
		e.add(n[3] + 1, 0, [[
			"exit",
			o,
			t
		]]);
	}
	return i !== void 0 && (a.end = Object.assign({}, fw(t.events, i)), e.add(i, 0, [[
		"exit",
		a,
		t
	]]), a = void 0), a;
}
function dw(e, t, n, r, i) {
	let a = [], o = fw(t.events, n);
	i && (i.end = Object.assign({}, o), a.push([
		"exit",
		i,
		t
	])), r.end = Object.assign({}, o), a.push([
		"exit",
		r,
		t
	]), e.add(n + 1, 0, a);
}
function fw(e, t) {
	let n = e[t], r = n[0] === "enter" ? "start" : "end";
	return n[1][r];
}
//#endregion
//#region node_modules/micromark-extension-gfm-task-list-item/lib/syntax.js
var pw = {
	name: "tasklistCheck",
	tokenize: hw
};
function mw() {
	return { text: { 91: pw } };
}
function hw(e, t, n) {
	let r = this;
	return i;
	function i(t) {
		return r.previous !== null || !r._gfmTasklistFirstContentOfListItem ? n(t) : (e.enter("taskListCheck"), e.enter("taskListCheckMarker"), e.consume(t), e.exit("taskListCheckMarker"), a);
	}
	function a(t) {
		return Sg(t) ? (e.enter("taskListCheckValueUnchecked"), e.consume(t), e.exit("taskListCheckValueUnchecked"), o) : t === 88 || t === 120 ? (e.enter("taskListCheckValueChecked"), e.consume(t), e.exit("taskListCheckValueChecked"), o) : n(t);
	}
	function o(t) {
		return t === 93 ? (e.enter("taskListCheckMarker"), e.consume(t), e.exit("taskListCheckMarker"), e.exit("taskListCheck"), s) : n(t);
	}
	function s(r) {
		return Z(r) ? t(r) : Q(r) ? e.check({ tokenize: gw }, t, n)(r) : n(r);
	}
}
function gw(e, t, n) {
	return $(e, r, "whitespace");
	function r(e) {
		return e === null ? n(e) : t(e);
	}
}
//#endregion
//#region node_modules/micromark-extension-gfm/index.js
function _w(e) {
	return ug([
		NC(),
		YC(),
		rw(e),
		sw(),
		mw()
	]);
}
//#endregion
//#region node_modules/remark-gfm/lib/index.js
var vw = {};
function yw(e) {
	let t = this, n = e || vw, r = t.data(), i = r.micromarkExtensions ||= [], a = r.fromMarkdownExtensions ||= [], o = r.toMarkdownExtensions ||= [];
	i.push(_w(n)), a.push(SC()), o.push(CC(n));
}
//#endregion
//#region assistant/assistant.css
var bw = _(), xw = "m4 4 16 8-16 8 3-8zM7 12h13";
function Sw() {
	return /* @__PURE__ */ (0, H.jsx)(yx, {
		remarkPlugins: [yw],
		className: "ai-markdown"
	});
}
function Cw() {
	let e = B((e) => e.message.role), t = B((e) => e.message.status?.type === "incomplete");
	return B((e) => e.message.content.some((e) => e.type === "text" && e.text)) ? /* @__PURE__ */ (0, H.jsxs)(vp.Root, {
		className: e === "user" ? "ai-bubble ai-bubble-out" : "ai-bubble ai-bubble-in",
		children: [/* @__PURE__ */ (0, H.jsx)("div", {
			className: "ai-bubble-text",
			children: /* @__PURE__ */ (0, H.jsx)(vp.Parts, { components: e === "assistant" ? { Text: Sw } : void 0 })
		}), t && /* @__PURE__ */ (0, H.jsx)("span", {
			className: "ai-incomplete",
			children: "Respuesta incompleta"
		})]
	}) : null;
}
function ww({ ctx: e, request: t, useDraft: n, active: r, api: i, draftPrompt: a, draftLabel: o }) {
	let [s, c] = (0, j.useState)([]), [l, u] = (0, j.useState)(!1), [d, f] = (0, j.useState)(!1), [p, m] = (0, j.useState)(""), [h, g] = (0, j.useState)(""), [_, v] = (0, j.useState)(null), [y, b] = (0, j.useState)(null), [x, S] = (0, j.useState)([]), [C, w] = (0, j.useState)(""), T = (0, j.useRef)(0), E = (0, j.useRef)("chat"), D = (0, j.useRef)(null), O = (0, j.useRef)(!1), k = (0, j.useRef)(!1), ee = (0, j.useRef)(y);
	ee.current = y;
	let A = (0, j.useRef)(null), te = (0, j.useRef)(!0), ne = (0, j.useRef)(r);
	ne.current = r;
	let M = (0, j.useRef)(Promise.resolve()), re = (0, j.useRef)(!1), N = (0, j.useRef)(!0), P = (0, j.useRef)(null), ie = (0, j.useRef)(null);
	(0, j.useEffect)(() => () => {
		te.current = !1;
	}, []);
	let ae = (0, j.useCallback)((e) => a && e === a && o ? o : e, [o, a]), oe = (0, j.useCallback)(async () => {
		if (!e.account || !e.chat) return;
		let n = ++T.current, r = await t(`/api/ai/proposals?${new URLSearchParams({
			account: e.account,
			chat: e.chat
		})}`);
		n === T.current && S((r.proposals || []).filter((e) => typeof e.id == "string" && typeof e.text == "string"));
	}, [
		e.account,
		e.chat,
		t
	]), se = (0, j.useCallback)((n = !1) => {
		if (D.current && (!n || O.current || i.pending || ee.current)) return D.current;
		if (!e.account || !e.chat) return Promise.resolve();
		let r = D.current;
		O.current = !0, u(!0);
		let a = t(`/api/ai/session?${new URLSearchParams({
			account: e.account,
			chat: e.chat
		})}`).then((e) => {
			if (!te.current) return;
			E.current = e.sessionId || "chat";
			let t = (e.messages || []).filter((e) => ["user", "assistant"].includes(e.role) && typeof e.content == "string").map((e, t) => ({
				id: `${E.current}-${t}`,
				role: e.role,
				content: [{
					type: "text",
					text: ae(e.content)
				}]
			})), n = k.current;
			k.current = !0;
			let r = A.current;
			c((e) => [...t, ...n ? e.filter((e) => e.id === r) : e]);
		}).catch((e) => {
			throw D.current = r, e;
		}).finally(() => {
			O.current = !1, te.current && u(!1);
		});
		return D.current = a, a;
	}, [
		i,
		e.account,
		e.chat,
		t,
		ae
	]);
	(0, j.useEffect)(() => {
		r && se(!0).catch((e) => {
			te.current && g(e.message);
		});
	}, [
		r,
		e.version,
		se
	]), (0, j.useEffect)(() => {
		if (!r || !e.chat) return;
		let t = !0;
		return oe().catch((e) => {
			t && g(e.message);
		}), () => {
			t = !1;
		};
	}, [
		r,
		e.chat,
		oe
	]);
	let ce = (0, j.useCallback)(() => ne.current ? oe() : Promise.resolve(), [oe]), le = async (n, r) => {
		if (!C) {
			w(n), g("");
			try {
				await t("/api/ai/proposal", {
					account: e.account,
					chat: e.chat,
					id: n,
					action: r
				}), S((e) => e.filter((e) => e.id !== n)), await ce().catch((e) => g(`No se pudieron actualizar las propuestas: ${e.message}`));
			} catch (e) {
				g(e.message), ce().catch(() => {});
			} finally {
				w("");
			}
		}
	}, ue = (0, j.useCallback)(() => {
		let e = P.current?.querySelector(".ai-history");
		e && N.current && (e.scrollTop = e.scrollHeight);
	}, []), de = (0, j.useCallback)(async (n, { allowPropose: r = !0, allowSend: i = !0, userId: a = `user-${crypto.randomUUID()}` } = {}) => {
		let o = String(n || "").trim();
		if (!o) return "";
		if (!e.account || !e.chat) throw Error("Selecciona una conversación para consultar.");
		let s = `answer-${a}`;
		A.current = a, N.current = !0, b(null), v({
			phase: "thinking",
			label: "Pensando"
		}), c((e) => e.some((e) => e.id === a) ? e.filter((e) => e.id !== s) : [...e, {
			id: a,
			role: "user",
			content: [{
				type: "text",
				text: ae(o)
			}]
		}]);
		let l = (e, t = !1) => {
			let n = {
				id: s,
				role: "assistant",
				content: [{
					type: "text",
					text: e
				}],
				status: t ? {
					type: "complete",
					reason: "stop"
				} : { type: "running" }
			};
			c((e) => e.some((e) => e.id === s) ? e.map((e) => e.id === s ? n : e) : [...e, n]);
		}, u = "";
		try {
			await se();
			let n = await t("/api/ai/chat", {
				account: e.account,
				chat: e.chat,
				message: o,
				allowPropose: r,
				allowSend: i,
				stream: !0,
				turnId: a.replace(/^user-/, "")
			}, (e, t) => {
				e === "activity" && t && typeof t.label == "string" && v(t), e === "delta" && typeof t.text == "string" && (u += t.text, v({
					phase: "writing",
					label: "Escribiendo"
				}), l(u)), e === "result" && v(null);
			}), s = typeof n.text == "string" ? n.text : "";
			return l(s, !0), v(null), ce().catch((e) => g(`No se pudieron actualizar las propuestas: ${e.message}`)), s;
		} catch (e) {
			throw b({
				text: o,
				options: {
					allowPropose: r,
					allowSend: i,
					userId: a
				}
			}), g(e.message), u && c((e) => e.map((e) => e.id === s ? {
				...e,
				status: {
					type: "incomplete",
					reason: "error"
				}
			} : e)), e;
		} finally {
			A.current = null, v(null);
		}
	}, [
		e.account,
		e.chat,
		se,
		ce,
		t,
		ae
	]), fe = (0, j.useCallback)((e) => {
		i.pending = (i.pending || 0) + 1;
		let t = () => (f(!0), g(""), Promise.resolve().then(e).finally(() => f(!1))), n = M.current.then(t, t).finally(() => {
			i.pending--;
		});
		return M.current = n.then(() => {}, () => {}), n;
	}, [i]), pe = (0, j.useCallback)((e, t) => fe(() => de(e, t)), [fe, de]);
	(0, j.useEffect)(() => (i.ask = pe, i.onReady?.(), delete i.onReady, () => {
		i.ask === pe && (i.ask = null);
	}), [i, pe]);
	let me = (0, j.useCallback)((e) => {
		let t = e.content.filter((e) => e.type === "text").map((e) => e.text).join("").trim();
		return !t || re.current ? Promise.resolve() : (re.current = !0, m(""), ie.current?.focus(), fe(() => de(t)).catch((e) => (g(e.message), Promise.reject(e))).finally(() => {
			re.current = !1;
		}));
	}, [fe, de]), he = ml({
		messages: s,
		onNew: me,
		convertMessage: (e) => e,
		isRunning: d,
		isSendDisabled: !e.chat || l || d
	}), F = [...s].reverse().find((e) => e.role === "assistant")?.content[0]?.text || "", I = () => {
		!y || re.current || d || (re.current = !0, pe(y.text, y.options).catch(() => {}).finally(() => {
			re.current = !1;
		}));
	}, ge = (e) => {
		e.preventDefault();
		let t = p.trim();
		t && !d && !l && me({
			role: "user",
			content: [{
				type: "text",
				text: t
			}]
		}).catch(() => {});
	}, _e = (e) => {
		e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.preventDefault(), e.currentTarget.form?.requestSubmit());
	};
	(0, j.useEffect)(() => {
		let e = ie.current;
		e && (e.style.height = "auto", e.style.height = `${Math.min(e.scrollHeight, 160)}px`);
	}, [
		p,
		r,
		e.chat
	]), (0, j.useEffect)(() => {
		r && ue();
	}, [
		r,
		s,
		_,
		d,
		l,
		ue
	]);
	let ve = e.chat ? "Escribe para consultar sobre esta conversación." : "Selecciona una conversación para empezar.";
	return /* @__PURE__ */ (0, H.jsx)(ld, {
		runtime: he,
		children: /* @__PURE__ */ (0, H.jsx)("div", {
			className: "ai-thread",
			ref: P,
			children: /* @__PURE__ */ (0, H.jsxs)(nm.Root, {
				className: "ai-conversation",
				children: [
					/* @__PURE__ */ (0, H.jsxs)(nm.Viewport, {
						className: "ai-history",
						"aria-label": "Conversación con Social Media Agent",
						onScroll: (e) => {
							let t = e.currentTarget;
							N.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
						},
						children: [
							l ? /* @__PURE__ */ (0, H.jsx)("p", {
								className: "ai-note",
								role: "status",
								children: "Cargando conversación…"
							}) : s.length === 0 ? /* @__PURE__ */ (0, H.jsx)("p", {
								className: "ai-note",
								children: ve
							}) : null,
							/* @__PURE__ */ (0, H.jsx)(nm.Messages, { components: { Message: Cw } }),
							d && _ && /* @__PURE__ */ (0, H.jsxs)("div", {
								className: "ai-activity",
								role: "status",
								"aria-live": "polite",
								children: [
									/* @__PURE__ */ (0, H.jsx)("span", {
										className: `ai-activity-icon ${_.phase === "tool" ? "ai-tool-icon" : ""}`,
										"aria-hidden": "true",
										children: _.phase === "tool" ? "⌘" : "✦"
									}),
									/* @__PURE__ */ (0, H.jsx)("span", { children: _.label || "Pensando" }),
									/* @__PURE__ */ (0, H.jsxs)("span", {
										className: "ai-typing",
										"aria-hidden": "true",
										children: [
											/* @__PURE__ */ (0, H.jsx)("span", {}),
											/* @__PURE__ */ (0, H.jsx)("span", {}),
											/* @__PURE__ */ (0, H.jsx)("span", {})
										]
									})
								]
							}),
							h && /* @__PURE__ */ (0, H.jsxs)("div", {
								className: "ai-error",
								role: "alert",
								children: [/* @__PURE__ */ (0, H.jsx)("p", { children: h }), y && !d && /* @__PURE__ */ (0, H.jsx)("button", {
									type: "button",
									onClick: I,
									children: "Reintentar"
								})]
							}),
							F && !d && !y && /* @__PURE__ */ (0, H.jsx)("button", {
								id: "ai-use-draft",
								type: "button",
								disabled: !e.chat,
								onClick: () => n(F, e),
								children: "Usar como borrador"
							})
						]
					}),
					x.length > 0 && /* @__PURE__ */ (0, H.jsxs)("section", {
						className: "ai-proposals",
						"aria-label": "Propuestas pendientes",
						children: [
							/* @__PURE__ */ (0, H.jsx)("h3", { children: "Propuestas pendientes" }),
							/* @__PURE__ */ (0, H.jsx)("p", { children: "Revisa el texto exacto antes de aprobar su envío por WhatsApp." }),
							x.map((e) => /* @__PURE__ */ (0, H.jsxs)("article", {
								className: "ai-proposal",
								children: [/* @__PURE__ */ (0, H.jsx)("div", {
									className: "ai-proposal-text",
									children: e.text
								}), /* @__PURE__ */ (0, H.jsxs)("div", {
									className: "ai-proposal-actions",
									children: [/* @__PURE__ */ (0, H.jsx)("button", {
										type: "button",
										disabled: !!C,
										onClick: () => le(e.id, "reject"),
										children: "Descartar"
									}), /* @__PURE__ */ (0, H.jsx)("button", {
										type: "button",
										className: "primary",
										disabled: !!C,
										onClick: () => le(e.id, "approve"),
										children: "Aprobar y enviar"
									})]
								})]
							}, e.id))
						]
					}),
					/* @__PURE__ */ (0, H.jsxs)("form", {
						className: "ai-composer",
						onSubmit: ge,
						children: [
							/* @__PURE__ */ (0, H.jsx)("label", {
								className: "sr-only",
								htmlFor: "ai-prompt",
								children: "Mensaje para Social Media Agent"
							}),
							/* @__PURE__ */ (0, H.jsx)("textarea", {
								id: "ai-prompt",
								ref: ie,
								value: p,
								onChange: (e) => m(e.target.value),
								onKeyDown: _e,
								placeholder: "Escribe un mensaje",
								rows: "1",
								disabled: !e.chat || l
							}),
							/* @__PURE__ */ (0, H.jsx)("button", {
								id: "ai-send",
								className: "ai-send",
								type: "submit",
								disabled: !e.chat || l || d || !p.trim(),
								"aria-label": "Enviar mensaje",
								children: /* @__PURE__ */ (0, H.jsx)("svg", {
									viewBox: "0 0 24 24",
									focusable: "false",
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, H.jsx)("path", { d: xw })
								})
							})
						]
					})
				]
			})
		})
	});
}
function Tw(e, { request: t, useDraft: n, draftPrompt: r = "", draftLabel: i = "" }) {
	let a = {
		draftPrompt: r,
		draftLabel: i
	}, o = {
		account: "",
		chat: "",
		version: 0
	}, s = !1, c = /* @__PURE__ */ new Map(), l, u = (e, r) => e.root.render(/* @__PURE__ */ (0, H.jsx)(ww, {
		ctx: e.ctx,
		active: r,
		request: t,
		useDraft: n,
		api: e.api,
		draftPrompt: a.draftPrompt,
		draftLabel: a.draftLabel
	})), d = () => {
		let t = JSON.stringify([o.account, o.chat]), n = c.get(t);
		if (!n) {
			let e = document.createElement("div");
			e.className = "ai-context";
			let r = {}, i = new Promise((e) => {
				r.onReady = e;
			});
			n = {
				element: e,
				root: (0, bw.createRoot)(e),
				api: r,
				ready: i,
				ctx: o
			}, c.set(t, n);
		}
		l && l !== n && u(l, !1), n.ctx = o, l = n, e.firstChild !== n.element && e.replaceChildren(n.element), c.delete(t), c.set(t, n), u(n, s);
		for (let [e, t] of c) {
			if (c.size <= 8) break;
			t === n || t.api.pending || (t.root.unmount(), c.delete(e));
		}
	};
	return d(), {
		select(e) {
			o = e, d();
		},
		setOpen(t) {
			s = t, d(), s && requestAnimationFrame(() => e.querySelector("#ai-prompt")?.focus());
		},
		async proposeDraft(e) {
			let t = String(e || "").trim();
			if (!t) throw Error("No se pudo preparar la propuesta.");
			if (!o.account || !o.chat) throw Error("Selecciona una conversación para pedir una propuesta.");
			let n = l;
			n.api.pending = (n.api.pending || 0) + 1;
			try {
				return await n.ready, await n.api.ask(t, {
					allowPropose: !0,
					allowSend: !1
				});
			} finally {
				n.api.pending--;
			}
		}
	};
}
//#endregion
export { Tw as mountAssistant };
