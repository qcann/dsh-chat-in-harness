/**
 * dsh-chat-in-harness — 浏览器半个插件（从零实现，不依赖任何第三方插件代码）。
 *
 * 目标：在 DSH 桌面端挂一个「与会话无关」的聊天浮窗。
 *
 * 为什么能跨会话：
 *   浮窗的 DOM 直接挂在 document.body 上，不在 React 树里、也不属于任何
 *   会话的插槽。会话切换、面板切换只影响 React 树，碰不到这份 DOM，
 *   所以窗口和里面的 <webview> 实例一直活着。
 *
 * 依赖的 DSH 公开能力（都来自宿主自身）：
 *   window.dshDesktop.browser.acquire(workspace) -> { lease, partition }
 *   window.dshDesktop.browser.onOpenRequested(lease, cb) -> unsubscribe
 *   ctx.slots.inject / ctx.slots.register（sidebar.footer.action、settings.section）
 */

window.__ModuleLoader__.load({
	id: "dsh-chat-in-harness",
	factory: (require) => {
		"use strict";

		const React = require("react");
		const h = React.createElement;

		const HOME = "https://chat.deepseek.com/";
		const PANEL_ID = "dsh-chat-in-harness";
		/**
		 * 插槽 id 每次加载都换一个：热重载/重复激活时，旧实例可能还占着同一个 id，
		 * 用固定 id 会让新实例注册直接抛 duplicate 错误、整块 UI 消失。
		 * 注意不能改 PANEL_ID —— 它同时是浏览器租约的 workspace key，改了会换分区、丢登录态。
		 */
		const SLOT_ID = `${PANEL_ID}-${Math.random().toString(36).slice(2, 8)}`;
		const LAYOUT_KEY = "dsh-chat-in-harness:layout:v1";

		const MIN_W = 320;
		const MIN_H = 380;
		const DEFAULT_W = 480;
		const DEFAULT_H = 820;

		const TOP_SAFE_DEFAULT = 56;
		/** 顶部让位：优先读宿主注入的 Windows 标题栏高度，再留 20px 呼吸位（与 dockkit 一致）。 */
		let TOP_SAFE = TOP_SAFE_DEFAULT;
		const ZOOM_STEPS = [1, 0.9, 0.8];
		/** 整窗不透明度：只影响观感，不影响输入。 */
		const OPACITY_STEPS = [1, 0.9, 0.8];

		// 界面语言跟随 DSH 的全局语言：中文以外的语言一律用英文。
		let LANG = "zh";
		const langListeners = new Set();

		function setLang(locale) {
			const next = String(locale || "").toLowerCase().startsWith("zh") ? "zh" : "en";
			if (next === LANG) return;
			LANG = next;
			for (const listener of langListeners) {
				try {
					listener();
				} catch {
					/* ignore */
				}
			}
		}

		function t(zh, en) {
			return LANG === "zh" ? zh : en;
		}
		const DEFAULT_ZOOM = 0.9;

		/** 只在深色/浅色都安全的前提下用宿主主题变量。 */
		const state = {
			root: null,
			titledButtons: [],
			body: null,
			cover: null,
			ball: null,
			guest: null,
			lease: null,
			started: false,
			layoutTimer: null,
			unsubscribeOpen: undefined,
			drag: null,
			resize: null,
			ballDrag: null,
			open: true,
			minimized: false,
			maximizedRect: undefined,
			animTimer: undefined,
			backBtn: undefined,
			forwardBtn: undefined,
			address: undefined,
			closed: false,
			zoom: DEFAULT_ZOOM,
			opacity: 1,
			opacityBtn: undefined,
			zoomBtn: undefined,
			maximizeBtn: undefined,
		};

		// ---------------------------------------------------------------- 基础

		const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

		function bridge() {
			const desktop = globalThis.dshDesktop;
			if (!desktop || desktop.protocolVersion !== 1 || !desktop.browser) return undefined;
			return desktop.browser;
		}

		/** 去掉 UA 里的 Electron 标记；其余指纹保持原样。 */
		function guestUserAgent() {
			const raw = typeof navigator === "object" ? String(navigator.userAgent || "") : "";
			if (!raw) return undefined;
			const clean = raw
				.split(/\s+/)
				.filter((token) => token && !/^electron\//i.test(token))
				.join(" ")
				.trim();
			return clean || undefined;
		}

		function isAllowed(raw) {
			let url;
			try {
				url = new URL(String(raw));
			} catch {
				return false;
			}
			if (url.protocol !== "https:" && url.protocol !== "http:") return false;
			const host = url.hostname.toLowerCase();
			return host === "deepseek.com" || host.endsWith(".deepseek.com");
		}

		function openExternal(url) {
			try {
				window.open(url, "_blank", "noopener,noreferrer");
			} catch {
				/* 弹窗被拦就算了 */
			}
		}

		/** 当前网页地址；还没加载出真实页面时回首页。 */
		function currentGuestUrl() {
			try {
				const url = String(state.guest?.getURL?.() ?? "");
				return url && !url.startsWith("about:blank") ? url : HOME;
			} catch {
				return HOME;
			}
		}

		// ---------------------------------------------------------------- 布局持久化

		function readLayout() {
			try {
				const raw = window.localStorage.getItem(LAYOUT_KEY);
				if (!raw) return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : {};
			} catch {
				return {};
			}
		}

		function writeLayout(patch) {
			try {
				window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...readLayout(), ...patch }));
			} catch {
				/* 隐私模式等 —— 位置不记住也不影响用 */
			}
		}

		function defaultRect() {
			const vw = window.innerWidth || 1280;
			const vh = window.innerHeight || 820;
			const w = Math.min(DEFAULT_W, Math.max(MIN_W, vw - 120));
			const hgt = Math.min(DEFAULT_H, Math.max(MIN_H, vh - 120));
			// 垂直居中（不再贴底），再把底部留白收进安全范围
			const y = Math.max(TOP_SAFE, Math.round((vh - hgt) / 2));
			return { x: Math.max(24, vw - w - 48), y, w, h: hgt };
		}

		function currentRect() {
			const box = state.root;
			return {
				x: parseFloat(box.style.left) || 0,
				y: parseFloat(box.style.top) || 0,
				w: parseFloat(box.style.width) || DEFAULT_W,
				h: parseFloat(box.style.height) || DEFAULT_H,
			};
		}

		/** 读宿主的 CSS 令牌，读不到就用兜底值。 */
		function readToken(name, fallback) {
			try {
				const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
				return value || fallback;
			} catch {
				return fallback;
			}
		}

		function clampRect(rect) {
			const vw = window.innerWidth || 1280;
			const vh = window.innerHeight || 820;
			const w = clamp(rect.w, MIN_W, Math.max(MIN_W, vw - 32));
			const hgt = clamp(rect.h, MIN_H, Math.max(MIN_H, vh - 32));
			// 至少留 72px 的标题栏在视口里，且不做移出顶部安全区（会压到 DSH 的标题条）
			const x = clamp(rect.x, 72 - w, vw - 72);
			const y = clamp(rect.y, TOP_SAFE, Math.max(TOP_SAFE, vh - 44));
			return { x, y, w, h: hgt };
		}

		function applyRect(rect) {
			const box = state.root;
			if (!box) return;
			box.style.left = `${rect.x}px`;
			box.style.top = `${rect.y}px`;
			box.style.width = `${rect.w}px`;
			box.style.height = `${rect.h}px`;
		}

		/** 松手贴边：距左右/上下边缘 16px 内就吸附过去（不会飞出可视区）。 */
		/** 贴边后的目标矩形（不直接应用，交给 animateTo 做缓动）。 */
		function snapRect() {
			const rect = currentRect();
			const vw = window.innerWidth || 1280;
			const vh = window.innerHeight || 820;
			const SNAP = 16;
			let x = rect.x;
			let y = rect.y;
			if (x < SNAP) x = 0;
			else if (x + rect.w > vw - SNAP) x = Math.max(0, vw - rect.w);
			if (y < TOP_SAFE + SNAP) y = TOP_SAFE;
			else if (y + rect.h > vh - SNAP) y = Math.max(TOP_SAFE, vh - rect.h);
			return clampRect({ ...rect, x, y });
		}

		/** 带缓动的定位：拖动松手、最大化/还原时用，避免硬跳。 */
		function animateTo(rect) {
			const box = state.root;
			if (!box) return;
			box.classList.add("cf-anim");
			applyRect(rect);
			clearTimeout(state.animTimer);
			state.animTimer = setTimeout(() => box.classList.remove("cf-anim"), 220);
		}

		function persistRect() {
			clearTimeout(state.layoutTimer);
			state.layoutTimer = setTimeout(() => {
				if (!state.root) return;
				const rect = currentRect();
				writeLayout({ ...rect, open: state.open, minimized: state.minimized, zoom: state.zoom, opacity: state.opacity });
			}, 250);
		}

		// ---------------------------------------------------------------- 错误显示

		/** 出错时直接盖在浮窗内容上，而不是记到别处。 */
		function showCover(text) {
			if (!state.cover) return;
			state.cover.textContent = text;
			state.cover.style.display = "flex";
		}

		function hideCover() {
			if (state.cover) state.cover.style.display = "none";
		}

		/** 网页缩放：登录页在窄面板里会横向溢出、纵向超长，缩一点就能整页看到。 */
		function applyZoom() {
			const guest = state.guest;
			if (state.zoomBtn) {
				const label = t(`缩放 ${Math.round(state.zoom * 100)}%`, `Zoom ${Math.round(state.zoom * 100)}%`);
				state.zoomBtn.title = label;
				state.zoomBtn.setAttribute("aria-label", label);
			}
			if (!guest) return;
			try {
				if (typeof guest.setZoomFactor === "function") guest.setZoomFactor(state.zoom);
			} catch {
				/* 页面未就绪时忽略，加载完成会再调一次 */
			}
		}

		function cycleZoom() {
			const index = ZOOM_STEPS.indexOf(state.zoom);
			state.zoom = ZOOM_STEPS[(index + 1) % ZOOM_STEPS.length];
			applyZoom();
			writeLayout({ zoom: state.zoom });
		}

		/** 整窗不透明度：只影响观感，不改变交互。 */
		function applyOpacity() {
			if (state.root) state.root.style.opacity = String(state.opacity);
			if (state.opacityBtn) {
				const label = t(`不透明度 ${Math.round(state.opacity * 100)}%`, `Opacity ${Math.round(state.opacity * 100)}%`);
				state.opacityBtn.title = label;
				state.opacityBtn.setAttribute("aria-label", label);
			}
		}

		function cycleOpacity() {
			const index = OPACITY_STEPS.indexOf(state.opacity);
			state.opacity = OPACITY_STEPS[(index + 1) % OPACITY_STEPS.length];
			applyOpacity();
			writeLayout({ opacity: state.opacity });
		}

		// ---------------------------------------------------------------- DOM

		/** 把浮窗的样式一次注入为 <style>，让 hover / 缩放手柄这类伪元素规则能用。 */
		function injectStyles() {
			if (document.getElementById("dsh-chat-in-harness-style")) return;
			const style = document.createElement("style");
			style.id = "dsh-chat-in-harness-style";
			style.textContent = `
#dsh-chat-in-harness .cf-strip{display:flex;flex:none;gap:4px;align-items:center;height:38px;padding:10px 6px 0 10px;box-sizing:border-box;cursor:move;user-select:none;-webkit-app-region:no-drag}
#dsh-chat-in-harness .cf-tab{position:relative;display:flex;flex:0 1 auto;align-items:center;min-width:80px;max-width:170px;height:28px;padding:0 10px;color:var(--dsw-alias-label-secondary,#666);font-size:13px;line-height:1;white-space:nowrap;border-radius:var(--dsw-radius-sm,8px);cursor:inherit;touch-action:none;user-select:none}
#dsh-chat-in-harness .cf-tab-title{display:flex;flex:1 1 auto;gap:5px;align-items:center;min-width:0;overflow:hidden;line-height:1.4}
#dsh-chat-in-harness .cf-header{display:flex;flex-direction:column;flex:none}
#dsh-chat-in-harness .cf-navrow{display:flex;align-items:center;gap:4px;height:42px;padding:0 8px 8px 8px;box-sizing:border-box}
#dsh-chat-in-harness .cf-address{flex:1 1 auto;min-width:0;display:flex;align-items:center;height:30px;padding:0 12px;margin:0 2px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,10px);font-size:13px;line-height:1;color:var(--dsw-alias-label-primary,#1a1a1a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--dsw-alias-bg-base,#fff)}
#dsh-chat-in-harness .cf-brand{display:inline-flex;flex:none;align-items:center;line-height:0;color:#4d6bfe}
#dsh-chat-in-harness .cf-fill{flex:1 1 0;min-width:0}
#dsh-chat-in-harness .cf-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;color:var(--dsw-alias-label-secondary,#666);line-height:1;background:transparent;border:none;border-radius:var(--dsw-radius-sm,8px);cursor:pointer}
#dsh-chat-in-harness .cf-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
#dsh-chat-in-harness .cf-icon svg{width:15px;height:15px}
#dsh-chat-in-harness .cf-body{flex:1 1 auto;min-height:0;position:relative;background:var(--dsw-alias-bg-base,#fff)}
#dsh-chat-in-harness.cf-anim{transition:left .16s cubic-bezier(.2,.8,.2,1),top .16s cubic-bezier(.2,.8,.2,1),width .16s cubic-bezier(.2,.8,.2,1),height .16s cubic-bezier(.2,.8,.2,1)}
#dsh-chat-in-harness .cf-resize{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;touch-action:none;z-index:4}
#dsh-chat-in-harness .cf-resize::after{content:"";position:absolute;right:4px;bottom:4px;width:calc(var(--dsw-radius-panel,28px) - 12px);height:calc(var(--dsw-radius-panel,28px) - 12px);border-right:1.5px solid var(--dsw-alias-label-caption,rgba(0,0,0,.25));border-bottom:1.5px solid var(--dsw-alias-label-caption,rgba(0,0,0,.25));border-bottom-right-radius:calc(var(--dsw-radius-panel,28px) - 12px);opacity:0;transition:opacity .12s ease-out}
#dsh-chat-in-harness:hover .cf-resize::after{opacity:1}
#dsh-chat-in-harness .cf-resize:hover::after{border-color:var(--dsw-alias-label-tertiary,rgba(0,0,0,.45))}
#dsh-chat-in-harness .cf-cover{position:absolute;inset:0;display:none;align-items:center;justify-content:center;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8a8a);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));z-index:3;padding:24px;text-align:center}
`;
			document.head.appendChild(style);
		}

		/** 自绘虚线小鲸鱼轮廓（64×64），非 DeepSeek 官方标识。 */
		const BRAND_MOUTH = "M13 39C17 43.5 23 46 29 45.5";

		const BRAND_PATH =
			"M11 36C10.9 38.3 11.3 42.0 12 44C12.7 46.0 14.3 48.6 16 50C17.7 51.4 21.6 53.4 24 54C26.4 54.6 30.7 54.7 33 54C35.3 53.3 38.4 50.7 40 49C41.6 47.3 42.7 42.6 44 42C45.3 41.4 47.4 43.9 49 45C50.6 46.1 53.7 49.7 55 50C56.3 50.3 58.0 48.6 58 47C58.0 45.4 55.6 41.0 55 39C54.4 37.0 53.7 34.7 54 33C54.3 31.3 56.0 28.8 57 27C58.0 25.2 60.4 21.6 61 20C61.6 18.4 61.7 16.6 61 16C60.3 15.4 57.4 14.9 56 16C54.6 17.1 52.3 22.4 51 24C49.7 25.6 47.9 27.4 47 27C46.1 26.6 46.3 22.4 45 21C43.7 19.6 40.4 17.6 38 17C35.6 16.4 30.7 16.3 28 17C25.3 17.7 21.1 20.4 19 22C16.9 23.6 14.1 26.0 13 28C11.9 30.0 11.1 33.7 11 36";

		/** 同一份轮廓给三处用：标题栏、设置页导航、图标文件。 */
		function brandSvgMarkup(size) {
			// 小尺寸下把线加粗、虚线加长，否则 15px 缩放下会糊成一块
			const small = size < 24;
			const stroke = small ? 4.4 : 2.4;
			const dash = small ? "6.4 4.6" : "4.6 3.4";
			return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><path d="${BRAND_PATH}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-dasharray="${dash}" stroke-linecap="round" stroke-linejoin="round"/><path d="${BRAND_MOUTH}" fill="none" stroke="currentColor" stroke-width="${small ? 4.4 : 2.4}" stroke-dasharray="${small ? "6.4 4.6" : "4.6 3.4"}" stroke-linecap="round"/><circle cx="21" cy="31" r="${small ? 2.8 : 2}" fill="currentColor"/></svg>`;
		}

		function brandMark(size) {
			const span = document.createElement("span");
			span.className = "cf-brand";
			// 内联颜色兜底：宿主的 brand 令牌是近黑色，不能直接用
			span.style.color = "#4d6bfe";
			span.innerHTML = brandSvgMarkup(size);
			return span;
		}

		/** 15px 线性图标，笔画宽度与 dockkit 的 iconButton 一致（1.8）。 */
		const ICONS = {
			// 缩放用「A +」，比放大镜更像“调整页面字号”，不会和搜索混淆
			zoom: '<path d="M4.5 18.5L8.5 8l4 10.5"/><path d="M6.2 15h4.6"/><path d="M17.5 9.5v6"/><path d="M14.5 12.5h6"/>',
			// 半填充圆：常见的「不透明度 / 对比度」图标
			opacity: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
			reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
			external: '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>',
			close: '<path d="M5 5l14 14"/><path d="M19 5L5 19"/>',
			// 铺满 / 还原：单方框 vs 两个错位的方框
			maximize: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
			restore: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/>',
			back: '<path d="M15 5l-7 7 7 7"/>',
			forward: '<path d="M9 5l7 7-7 7"/>',
		};

		/** 生成一段 24×24 线性图标标记，icon() 与动态换图标共用。 */
		function svgMarkup(paths, strokeWidth) {
			const stroke = typeof strokeWidth === "number" ? strokeWidth : 1.8;
			return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
		}

		/** 图标按钮：labels 是 [中文, English]，语言切换时由 applyTitles 统一刷新。 */
		function icon(paths, labels, onClick, className, strokeWidth) {
			const el = document.createElement("button");
			el.type = "button";
			el.className = className || "cf-icon";
			state.titledButtons.push([el, labels[0], labels[1]]);
			el.title = t(labels[0], labels[1]);
			el.setAttribute("aria-label", el.title);
			const stroke = typeof strokeWidth === "number" ? strokeWidth : 1.8;
			el.innerHTML = svgMarkup(paths, stroke);
			el.addEventListener("pointerdown", (event) => event.stopPropagation());
			el.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				onClick();
			});
			return el;
		}

		/** 语言切换后刷新所有按钮提示，以及带数字的缩放/透明度标签。 */
		function applyTitles() {
			for (const pair of state.titledButtons) {
				const [el, zh, en] = pair;
				el.title = t(zh, en);
				el.setAttribute("aria-label", el.title);
			}
			applyZoom();
			applyOpacity();
			syncMaximizeButton();
		}

		function buildDom() {
			if (state.root) return;
			injectStyles();
			state.titledButtons = [];

			const root = document.createElement("div");
			root.id = "dsh-chat-in-harness";
			// 样式对齐 DSH 自己的 dockkit 浮窗：panel 圆角 + prominent 阴影 + float 层级
			root.style.cssText = [
				"position: fixed",
				"display: flex",
				"flex-direction: column",
				"box-sizing: border-box",
				"overflow: hidden",
				"border-radius: var(--dsw-radius-panel, 28px)",
				"background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #fff))",
				"--dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
				"box-shadow: var(--dsw-elevation-prominent, 0 0 0 1px rgba(0,0,0,.06), 0 3px 8px rgba(0,0,0,.04), 0 0 20px rgba(0,0,0,.05))",
				"z-index: var(--dsh-dockkit-float-layer, 60)",
				"will-change: left, top, width, height",
			].join(";");

			//   行 1 = tab strip（鲸鱼 + Chat） + 右端 缩放 / 不透明度 / 铺满 / 收起
			//   行 2 = 后退 / 前进 / 刷新 / 地址 / 在系统浏览器打开
			const header = document.createElement("header");
			header.className = "cf-header";

			const strip = document.createElement("div");
			strip.className = "cf-strip";
			strip.style.cursor = "move";
			strip.style.userSelect = "none";
			strip.style.webkitAppRegion = "no-drag";

			const tab = document.createElement("div");
			tab.className = "cf-tab";
			tab.style.cursor = "inherit";
			const tabTitle = document.createElement("span");
			tabTitle.className = "cf-tab-title";
			tabTitle.append(brandMark(15), document.createTextNode("Chat"));
			tab.append(tabTitle);

			const fill = document.createElement("div");
			fill.className = "cf-fill";

			const backBtn = icon(ICONS.back, ["后退", "Back"], () => {
				try {
					state.guest?.goBack?.();
				} catch {
					/* ignore */
				}
			});
			const forwardBtn = icon(ICONS.forward, ["前进", "Forward"], () => {
				try {
					state.guest?.goForward?.();
				} catch {
					/* ignore */
				}
			});
			backBtn.style.display = "none";
			forwardBtn.style.display = "none";
			state.backBtn = backBtn;
			state.forwardBtn = forwardBtn;

			const zoomBtn = icon(ICONS.zoom, ["缩放", "Zoom"], () => cycleZoom());
			state.zoomBtn = zoomBtn;

			const opacityBtn = icon(ICONS.opacity, ["不透明度", "Opacity"], () => cycleOpacity());
			state.opacityBtn = opacityBtn;

			const reload = icon(ICONS.reload, ["刷新", "Reload"], () => {
				try {
					state.guest?.reload();
				} catch {
					/* ignore */
				}
			});
			const external = icon(ICONS.external, ["在系统浏览器中打开当前页", "Open current page in browser"], () => openExternal(currentGuestUrl()));
			const maximize = icon(ICONS.maximize, ["铺满", "Maximize"], () => toggleMaximize());
			state.maximizeBtn = maximize;
			const close = icon(ICONS.close, ["收起浮窗", "Hide"], () => closeWindow(), undefined, 1.6);
			syncMaximizeButton();

			strip.append(tab, fill, zoomBtn, opacityBtn, maximize, close);

			const navRow = document.createElement("div");
			navRow.className = "cf-navrow";
			const address = document.createElement("span");
			address.className = "cf-address";
			address.textContent = HOME;
			navRow.append(backBtn, forwardBtn, reload, address, external);

			header.append(strip, navRow);

			const body = document.createElement("div");
			body.className = "cf-body";

			const cover = document.createElement("div");
			cover.className = "cf-cover";

			const resizer = document.createElement("div");
			resizer.className = "cf-resize";

			body.append(cover);
			root.append(header, body, resizer);

			const ball = document.createElement("div");
			ball.id = "dsh-chat-in-harness-ball";
			ball.title = t("Chat（单击展开）", "Chat (click to open)");
			ball.append(brandMark(28));
			ball.style.cssText = [
				"position: fixed",
				"display: none",
				"align-items: center",
				"justify-content: center",
				"width: 52px",
				"height: 52px",
				"border-radius: 50%",
				"background: var(--dsw-alias-bg-base, #fff)",
				"border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
				"cursor: pointer",
				"box-shadow: 0 8px 24px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08)",
				"z-index: 70",
				"user-select: none",
				"touch-action: none",
			].join(";");

			const host = document.body || document.documentElement;
			host.append(root, ball);

			state.root = root;
			state.body = body;
			state.cover = cover;
			state.ball = ball;
			state.address = address;

			installDrag(strip, root);
			installResize(resizer, root);
			installBall(ball);

			// 双击标题行：铺满 / 还原
			strip.addEventListener("dblclick", (event) => {
				if (event.target instanceof Element && event.target.closest("button")) return;
				toggleMaximize();
			});
		}

		// ---------------------------------------------------------------- 拖动 / 缩放

		function installDrag(handle, root) {
			handle.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				if (event.target instanceof Element && event.target.closest("button")) return;
				state.root?.classList.remove("cf-anim");
				const rect = currentRect();
				state.drag = { px: event.clientX, py: event.clientY, x: rect.x, y: rect.y };
				handle.setPointerCapture(event.pointerId);
				handle.style.cursor = "grabbing";
			});
			handle.addEventListener("pointermove", (event) => {
				const drag = state.drag;
				if (!drag) return;
				// 拖动只改位置、不改尺寸：铺满状态照样保留，
				// 这样图标始终是「还原」，也不会丢掉还原目标。
				const rect = currentRect();
				const vw = window.innerWidth || 1280;
				const vh = window.innerHeight || 820;
				// 允许 24px 的“过冲”，松手后再弹回边界内 —— 硬卡在边上会显得生硬
				const OVER = 24;
				applyRect({
					x: clamp(drag.x + (event.clientX - drag.px), -OVER, vw - rect.w + OVER),
					y: clamp(drag.y + (event.clientY - drag.py), TOP_SAFE - OVER, vh - rect.h + OVER),
					w: rect.w,
					h: rect.h,
				});
			});
			const end = (event) => {
				if (!state.drag) return;
				state.drag = null;
				handle.style.cursor = "move";
				try {
					handle.releasePointerCapture(event.pointerId);
				} catch {
					/* ignore */
				}
				animateTo(snapRect());
				persistRect();
			};
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		}

		function installResize(handle, root) {
			handle.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				event.stopPropagation();
				state.root?.classList.remove("cf-anim");
				const rect = currentRect();
				state.resize = { px: event.clientX, py: event.clientY, w: rect.w, h: rect.h };
				handle.setPointerCapture(event.pointerId);
			});
			handle.addEventListener("pointermove", (event) => {
				const resize = state.resize;
				if (!resize) return;
				if (state.maximizedRect && (Math.abs(event.clientX - resize.px) > 3 || Math.abs(event.clientY - resize.py) > 3)) {
					state.maximizedRect = undefined;
					syncMaximizeButton();
				}
				const rect = clampRect({
					...currentRect(),
					w: resize.w + (event.clientX - resize.px),
					h: resize.h + (event.clientY - resize.py),
				});
				applyRect(rect);
			});
			const end = (event) => {
				if (!state.resize) return;
				state.resize = null;
				try {
					handle.releasePointerCapture(event.pointerId);
				} catch {
					/* ignore */
				}
				persistRect();
			};
			handle.addEventListener("pointerup", end);
			handle.addEventListener("pointercancel", end);
		}

		function installBall(ball) {
			ball.addEventListener("pointerdown", (event) => {
				if (event.button !== 0) return;
				event.stopPropagation();
				const rect = ball.getBoundingClientRect();
				state.ballDrag = {
					px: event.clientX,
					py: event.clientY,
					left: rect.left,
					top: rect.top,
					moved: false,
				};
				ball.setPointerCapture(event.pointerId);
			});
			ball.addEventListener("pointermove", (event) => {
				const drag = state.ballDrag;
				if (!drag) return;
				const dx = event.clientX - drag.px;
				const dy = event.clientY - drag.py;
				if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
				const vw = window.innerWidth || 1280;
				const vh = window.innerHeight || 820;
				ball.style.left = `${clamp(drag.left + dx, 0, vw - 52)}px`;
				ball.style.top = `${clamp(drag.top + dy, 0, vh - 52)}px`;
			});
			const end = (event) => {
				const drag = state.ballDrag;
				state.ballDrag = null;
				try {
					ball.releasePointerCapture(event.pointerId);
				} catch {
					/* ignore */
				}
				if (drag && drag.moved) {
					writeLayout({ ballX: parseFloat(ball.style.left) || 0, ballY: parseFloat(ball.style.top) || 0 });
					return;
				}
				restoreWindow();
			};
			ball.addEventListener("pointerup", end);
		}

		// ---------------------------------------------------------------- 显示状态

		function showBall() {
			const ball = state.ball;
			if (!ball) return;
			const saved = readLayout();
			const rect = currentRect();
			ball.style.left = `${clamp(saved.ballX ?? rect.x + 8, 0, (window.innerWidth || 1280) - 52)}px`;
			ball.style.top = `${clamp(saved.ballY ?? rect.y + 8, 0, (window.innerHeight || 820) - 52)}px`;
			ball.style.display = "flex";
		}

		/** 悬浮球是否启用（默认不启用）。 */
		function ballEnabled() {
			return readLayout().ballEnabled === true;
		}

		/**
		 * 收起浮窗：启用悬浮球时收成鲸鱼球，否则彻底隐藏。
		 * 「最小化」和「关闭」共用这一条路径——区别只在文案，状态只有一个。
		 */
		function hideWindow() {
			if (!state.root) return;
			state.open = false;
			state.minimized = true;
			state.root.style.display = "none";
			if (ballEnabled()) {
				state.closed = false;
				showBall();
			} else {
				state.closed = true;
				if (state.ball) state.ball.style.display = "none";
			}
			// persistRect 会连同 open / minimized 一起写入，不必再单独 writeLayout
			persistRect();
		}

		function minimizeWindow() {
			hideWindow();
		}

		function closeWindow() {
			hideWindow();
		}

		function restoreWindow() {
			if (!state.root) return;
			state.minimized = false;
			state.closed = false;
			state.open = true;
			state.ball.style.display = "none";
			state.root.style.display = "flex";
			ensureGuest();
			persistRect();
		}

		function toggleWindow() {
			if (!state.root) return;
			if (state.minimized || !state.open) restoreWindow();
			else minimizeWindow();
		}


		/** 双击标题栏：铺满可用区域 / 还原到之前的矩形。 */
		function toggleMaximize() {
			if (!state.root) return;
			if (state.maximizedRect) {
				animateTo(clampRect(state.maximizedRect));
				state.maximizedRect = undefined;
			} else {
				state.maximizedRect = currentRect();
				const vw = window.innerWidth || 1280;
				const vh = window.innerHeight || 820;
				animateTo(clampRect({ x: 24, y: TOP_SAFE, w: Math.max(MIN_W, vw - 48), h: Math.max(MIN_H, vh - TOP_SAFE - 24) }));
			}
			syncMaximizeButton();
			persistRect();
		}

		/** 按钮图标跟随「是否处于铺满」切换：方框 ⇄ 双框。 */
		function syncMaximizeButton() {
			const btn = state.maximizeBtn;
			if (!btn) return;
			const restored = Boolean(state.maximizedRect);
			btn.innerHTML = svgMarkup(restored ? ICONS.restore : ICONS.maximize);
			btn.title = restored ? t("还原窗口", "Restore window") : t("铺满窗口", "Maximize window");
			btn.setAttribute("aria-label", btn.title);
		}

		// ---------------------------------------------------------------- webview

		/** 地址行只做展示，点击不进入编辑（需要打开外部页时用右侧 ↗）。 */
		function setAddress(url) {
			if (!state.address) return;
			const value = typeof url === "string" && /^https?:/i.test(url) ? url : HOME;
			state.address.textContent = value;
			state.address.title = value;
		}

		/** 有历史可退/可进时才显示对应按钮，避免空占位。 */
		function syncNav() {
			const guest = state.guest;
			if (!guest) return;
			try {
				const canBack = typeof guest.canGoBack === "function" && guest.canGoBack();
				const canForward = typeof guest.canGoForward === "function" && guest.canGoForward();
				if (state.backBtn) state.backBtn.style.display = canBack ? "inline-flex" : "none";
				if (state.forwardBtn) state.forwardBtn.style.display = canForward ? "inline-flex" : "none";
			} catch {
				/* 页面未就绪 */
			}
		}

		function ensureGuest() {
			if (state.guest) return state.guest;
			if (state.started) return undefined;
			const api = bridge();
			if (!api) {
				showCover(t("当前环境不支持内嵌浏览器（只支持 DSH 桌面端）。", "The embedded browser is only available in the DSH desktop app."));
				return undefined;
			}
			state.started = true;

			Promise.resolve()
				.then(() => api.acquire(PANEL_ID))
				.then((reservation) => {
					if (!reservation || typeof reservation.lease !== "string") throw new Error("no lease");
					state.lease = reservation.lease;

					const guest = document.createElement("webview");
					guest.setAttribute("partition", reservation.partition);
					guest.setAttribute("src", `about:blank#${reservation.lease}`);
					guest.setAttribute("allowpopups", "");
					guest.style.cssText = "width:100%;height:100%;display:flex;border:0;background:#fff;";

					const url = () => {
						try {
							return String(guest.getURL?.() ?? "");
						} catch {
							return "";
						}
					};

					guest.addEventListener("dom-ready", () => {
						const current = url();
						if (current.startsWith("about:blank")) {
							const ua = guestUserAgent();
							try {
								if (ua && typeof guest.setUserAgent === "function") guest.setUserAgent(ua);
								else if (ua) guest.setAttribute("useragent", ua);
							} catch {
								/* UA 设不上也继续，只是可能被判环境异常 */
							}
							applyZoom();
							try {
								guest.loadURL(HOME);
							} catch {
								/* ignore */
							}
							return;
						}
					});

					guest.addEventListener("did-stop-loading", () => {
						if (url().startsWith("about:blank")) return;
						hideCover();
						applyZoom();
						syncNav();
											});

					guest.addEventListener("did-navigate", (event) => {
						if (typeof event.url !== "string" || event.url.startsWith("about:blank")) return;
						setAddress(event.url);
						syncNav();
					});

					guest.addEventListener("did-navigate-in-page", (event) => {
						if (typeof event.url === "string") setAddress(event.url);
						syncNav();
					});

					// 导航白名单：非 deepseek.com 一律拦住，交系统浏览器
					guest.addEventListener("did-start-navigation", (event) => {
						if (!event.isMainFrame) return;
						if (typeof event.url !== "string" || event.url.startsWith("about:blank")) return;
						if (isAllowed(event.url)) return;
						try {
							guest.stop();
						} catch {
							/* ignore */
						}
						openExternal(event.url);
					});
					guest.addEventListener("will-navigate", (event) => {
						if (typeof event.url !== "string" || event.url.startsWith("about:blank")) return;
						if (isAllowed(event.url)) return;
						event.preventDefault();
						openExternal(event.url);
					});

					const unsubscribeOpen = api.onOpenRequested(reservation.lease, (target) => {
						// 站点自己开的弹窗（如「联系我们」）：deepseek 域内就地打开，
						// 域外交给系统浏览器。以前这里把域内弹窗直接丢了，点了没反应。
						if (isAllowed(target)) {
							try {
								guest.loadURL(target);
							} catch {
								/* ignore */
							}
							return;
						}
						openExternal(target);
					});

					state.body.append(guest);
					state.guest = guest;
					state.unsubscribeOpen = unsubscribeOpen;
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					showCover(t(`启动内嵌浏览器失败：${message}`, `Could not start the embedded browser: ${message}`));
										// 允许下次展开时重试
					state.started = false;
				});

			return state.guest;
		}

		// ---------------------------------------------------------------- 挂载 / 卸载

		function mount() {
			// 单例兜底：重复加载 / 热重载时，先清掉上一实例留下的 DOM，避免叠出多个浮窗
			for (const id of ["dsh-chat-in-harness", "dsh-chat-in-harness-ball", "dsh-chat-in-harness-style"]) {
				const stale = document.getElementById(id);
				if (stale) stale.remove();
			}
			// 代数：旧实例的清理只在自己仍是当前代时才拆 DOM
			state.generation = (state.generation || 0) + 1;
			const generation = state.generation;
			const saved = readLayout();
			// 顶部让位：Windows 读宿主注入的标题栏高度，macOS 没有该变量、标题栏也更矮，
			// 两种情况都再留 20px 呼吸位（与 dockkit 同口径）。
			const platform = document.documentElement.dataset.platform ?? "";
			const mac = /darwin|mac/i.test(platform);
			const fallbackTitlebar = mac ? 28 : 40;
			const titlebar = parseInt(readToken("--dsh-windows-titlebar-height", String(fallbackTitlebar)), 10);
			TOP_SAFE = (Number.isFinite(titlebar) && titlebar > 0 ? titlebar : fallbackTitlebar) + 20;
			// 旧版本布局没有 zoom 字段：视为旧快照，直接用新的默认尺寸与缩放，免得旧的小窗口继续沿用
			const legacy = typeof saved.zoom !== "number";
			state.zoom = legacy ? DEFAULT_ZOOM : saved.zoom;
			state.opacity = typeof saved.opacity === "number" ? saved.opacity : 1;
			buildDom();
			applyOpacity();
			const base = defaultRect();
			const rect = clampRect({
				x: !legacy && typeof saved.x === "number" ? saved.x : base.x,
				y: !legacy && typeof saved.y === "number" ? saved.y : base.y,
				w: !legacy && typeof saved.w === "number" ? saved.w : base.w,
				h: !legacy && typeof saved.h === "number" ? saved.h : base.h,
			});
			applyRect(rect);

			// 启动安静：不自动打开窗口，也不显示悬浮球。
			// 用户点左下角的 Chat 胶囊才打开——不打扰是默认状态。
			state.open = false;
			state.minimized = true;
			state.closed = true;
			state.root.style.display = "none";

			window.addEventListener("resize", onResize);
			document.addEventListener("keydown", onKeyDown, true);
			langListeners.add(applyTitles);
			return generation;
		}

		function onResize() {
			if (!state.root) return;
			applyRect(clampRect(currentRect()));
		}

		/** 焦点在浮窗内时按 Esc 收起。 */
		function onKeyDown(event) {
			if (event.key !== "Escape") return;
			if (!state.root || state.root.style.display === "none") return;
			if (!state.root.contains(document.activeElement)) return;
			event.preventDefault();
			minimizeWindow();
		}

		function unmount() {
			langListeners.delete(applyTitles);
			clearTimeout(state.layoutTimer);
			clearTimeout(state.animTimer);
			window.removeEventListener("resize", onResize);
			document.removeEventListener("keydown", onKeyDown, true);
			try {
				state.unsubscribeOpen?.();
			} catch {
				/* ignore */
			}
			const api = bridge();
			if (api && state.lease) api.release(state.lease).catch(() => {});
			state.root?.remove();
			state.ball?.remove();
			state.root = null;
			state.ball = null;
			state.guest = null;
			state.started = false;
		}

		// ---------------------------------------------------------------- 设置页

		const S = {
			page: { padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16, height: "100%", boxSizing: "border-box", overflowY: "auto" },
			card: {
				background: "var(--dsw-alias-bg-base, #fff)",
				border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
				borderRadius: "var(--dsw-radius-lg, 16px)",
				padding: "16px 18px",
				display: "flex",
				flexDirection: "column",
				gap: 12,
			},
			row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 },
			label: { fontSize: 13, color: "var(--dsw-alias-label-primary, #1a1a1a)" },
			hint: { fontSize: 12, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #8a8a8a)" },
			value: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #555)" },
			actions: { display: "flex", flexWrap: "wrap", gap: 8 },
		};

		function actionButton(label, onClick, danger) {
			return h(
				"button",
				{
					type: "button",
					onClick,
					style: {
						cursor: "pointer",
						padding: "6px 14px",
						fontSize: 13,
						borderRadius: "var(--dsw-radius-sm, 8px)",
						border: `1px solid ${danger ? "var(--dsw-alias-danger-color, #d1483b)" : "var(--dsw-alias-border-l2, rgba(0,0,0,.12))"}`,
						background: "transparent",
						color: danger ? "var(--dsw-alias-danger-color, #d1483b)" : "var(--dsw-alias-label-primary, #1a1a1a)",
					},
				},
				label,
			);
		}

		/** 开关：尺寸/配色照 DSH 自己的 switch（36×20，滑块 16px）。 */
		function toggleRow(label, hint, checked, onChange) {
			return h(
				"div",
				{ style: S.row },
				h(
					"div",
					null,
					h("div", { style: S.label }, label),
					hint ? h("div", { style: S.hint }, hint) : null,
				),
				h(
					"button",
					{
						type: "button",
						role: "switch",
						"aria-checked": checked ? "true" : "false",
						"aria-label": label,
						onClick: () => onChange(!checked),
						style: {
							boxSizing: "border-box",
							position: "relative",
							flex: "0 0 auto",
							width: 36,
							height: 20,
							padding: 2,
							border: 0,
							borderRadius: 999,
							background: checked ? "var(--dsw-alias-brand-primary, #1a1a1a)" : "var(--dsw-alias-border-l3, rgba(0,0,0,.16))",
							cursor: "pointer",
						},
					},
					h("span", {
						style: {
							display: "block",
							width: 16,
							height: 16,
							borderRadius: "50%",
							background: checked
								? "var(--dsw-alias-label-primary-foreground, #fff)"
								: "var(--dsw-alias-switch-thumb, #fff)",
							transition: "transform .12s ease",
							transform: checked ? "translateX(16px)" : "none",
						},
					}),
				),
			);
		}

		/** 左侧栏入口的显隐需要让设置页和入口本身同时更新，用一个极小的订阅表。 */
		const entryListeners = new Set();

		function notifyEntry() {
			for (const listener of entryListeners) {
				try {
					listener();
				} catch {
					/* ignore */
				}
			}
		}

		/** 左侧栏入口是否显示。 */
		function entryVisible() {
			return readLayout().showEntry !== false;
		}


		/** 左下角的紧凑入口：样式参考「新会话」胶囊，但不占满宽度。 */
		function ChatEntry() {
			const [visible, setVisible] = React.useState(entryVisible());
			React.useEffect(() => {
				const onChange = () => setVisible(entryVisible());
				entryListeners.add(onChange);
				langListeners.add(onChange);
				return () => {
					entryListeners.delete(onChange);
					langListeners.delete(onChange);
				};
			}, []);
			if (!visible) return null;
			return h(
				"button",
				{
					type: "button",
					title: t("打开或收起 Chat 浮窗", "Open or hide the Chat window"),
					onClick: () => toggleWindow(),
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
						height: 30,
						padding: "0 12px",
						margin: "4px 8px",
						borderRadius: "var(--dsw-radius-md, 10px)",
						border: "1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))",
						background: "transparent",
						color: "var(--dsw-alias-label-primary, #1a1a1a)",
						fontSize: 13,
						cursor: "pointer",
					},
				},
				h(
					"svg",
					{ width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
					h("path", { d: "M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-4.4A8 8 0 1 1 21 12Z" }),
				),
				"Chat",
			);
		}

		/** 渲染出错时不要静默变白板，把原因显示出来便于定位。 */
		function SettingsSection() {
			try {
				return renderSettings();
			} catch (error) {
				const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				console.error("[dsh-chat-in-harness] 设置页渲染失败", error);
				return h(
					"div",
					{ style: { padding: 24, fontSize: 13, color: "var(--dsw-alias-danger-color, #d1483b)", lineHeight: 1.6 } },
					t(`设置页渲染失败：${message}`, `Settings page failed to render: ${message}`),
				);
			}
		}

		function renderSettings() {
			const [, force] = React.useState(0);
			const refresh = () => force((v) => v + 1);
			// 语言变化时重渲染一次，文案跟着换
			React.useEffect(() => {
				const onChange = () => force((v) => v + 1);
				langListeners.add(onChange);
				return () => langListeners.delete(onChange);
			}, []);
			const layout = readLayout();
			const rect = state.root ? currentRect() : defaultRect();

			return h(
				"div",
				{ style: S.page },
				h(
					"div",
					{ style: S.card },
					h("div", { style: { ...S.label, fontWeight: 600 } }, t("行为", "Behavior")),
					toggleRow(t("在左侧栏显示入口", "Show entry in sidebar"), t("左下角的 Chat 胶囊；关掉后不再显示", "The Chat capsule above the avatar; hidden when off"), layout.showEntry !== false, (checked) => {
						writeLayout({ showEntry: checked });
						notifyEntry();
						refresh();
					}),
					toggleRow(t("启用悬浮球", "Enable floating ball"), t("最小化时收成鲸鱼球；不启用则「最小化」直接收起浮窗", "Collapse into the whale ball; if off, collapsing just hides the window"), ballEnabled(), (checked) => {
						writeLayout({ ballEnabled: checked });
						if (!checked) {
							state.minimized = false;
							if (state.ball) state.ball.style.display = "none";
						}
						refresh();
					}),
					h("div", { style: { height: 1, background: "var(--dsw-alias-border-l2, rgba(0,0,0,.08))", margin: "2px 0" } }),
					h("div", { style: S.hint }, t("重置窗口会恢复默认尺寸、90% 缩放、100% 不透明度，并打开浮窗。", "Reset window restores the default size, 90% zoom and 100% opacity, then opens it.")),
					h(
						"div",
						{ style: S.actions },
						actionButton(t("重置窗口", "Reset window"), () => {
							// 先打开再重置：用户能看到窗口动起来，才知道按钮生效了
							restoreWindow();
							state.zoom = DEFAULT_ZOOM;
							state.opacity = 1;
							animateTo(clampRect(defaultRect()));
							applyZoom();
							applyOpacity();
							persistRect();
							refresh();
						}),
					),
				),
				h(
					"div",
					{ style: S.card },
					h("div", { style: { ...S.label, fontWeight: 600 } }, t("状态", "Status")),
					h("div", { style: S.row }, h("span", { style: S.hint }, t("尺寸", "Size")), h("span", { style: S.value }, `${Math.round(rect.w)} × ${Math.round(rect.h)}`)),
					h("div", { style: S.row }, h("span", { style: S.hint }, t("网页缩放", "Page zoom")), h("span", { style: S.value }, `${Math.round(state.zoom * 100)}%`)),
					h("div", { style: S.row }, h("span", { style: S.hint }, t("不透明度", "Opacity")), h("span", { style: S.value }, `${Math.round(state.opacity * 100)}%`)),
				),
			);
		}


		/** 设置页左侧导航图标：复用同一份标记，颜色跟随导航文字。 */
		function Icon(props) {
			const size = typeof props?.size === "number" ? props.size : 18;
			return h("span", {
				style: { display: "inline-flex", color: "inherit" },
				dangerouslySetInnerHTML: { __html: brandSvgMarkup(size) },
			});
		}

		function apply(ctx) {
			// 单例：同一个页面里重复加载（热重载、重复激活）时，先把上一个实例拆干净
			const previous = globalThis.__dshChatInHarnessDispose;
			if (typeof previous === "function") {
				try {
					previous();
				} catch {
					/* ignore */
				}
				globalThis.__dshChatInHarnessDispose = undefined;
			}

			const disposers = [];
			// 每个注册都单独兜底：某一项失败（例如旧实例还占着同一个 id）不能连累其它项
			const safely = (what, run) => {
				try {
					disposers.push(run());
				} catch (error) {
					console.error(`[dsh-chat-in-harness] ${what} 注册失败`, error);
				}
			};

			// 语言跟随 DSH 全局设置：中文以外的语言一律英文
			safely("语言", () =>
				ctx.effect(() => {
					try {
						setLang(ctx.locale.getLocale().active);
						const off = ctx.locale.subscribe(() => {
							setLang(ctx.locale.getLocale().active);
						});
						return typeof off === "function" ? off : () => {};
					} catch {
						return () => {};
					}
				}, "chat.lang"),
			);

			safely("浮窗 DOM", () =>
				ctx.effect(() => {
					const generation = mount();
					return () => {
						// 已经换了新实例的话，旧清理不能动手
						if (state.generation === generation) unmount();
					};
				}, "chat.float.mount"),
			);

			// 左下角入口（头像上方那行）：紧凑的 Chat 胶囊
			safely("左侧栏入口", () =>
				ctx.slots.inject("sidebar.footer.action", () =>
					ctx.slots.register({ name: "sidebar.footer.action", id: SLOT_ID }, ChatEntry),
				),
			);

			// 设置页：左侧导航一项 + 对应图标
			safely("设置页", () =>
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: SLOT_ID,
							order: 30,
							label: () => "Chat in Harness",
						},
						SettingsSection,
					),
				),
			);

			safely("设置页图标", () =>
				ctx.slots.inject("settings.section.icon", () =>
					ctx.slots.register({ name: "settings.section.icon", id: SLOT_ID }, Icon),
				),
			);

			const cleanup = () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch {
						/* ignore */
					}
				}
				unmount();
			};
			globalThis.__dshChatInHarnessDispose = cleanup;
			return cleanup;
		}

		return { apply, inject: ["slots", "locale"] };
	},
});
