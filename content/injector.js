// content/injector.js - 注入编辑器到页面

(function() {
    'use strict';

    console.log('[HTMLEditor] IIFE 开始执行');

    // 防止重复注入
    if (window.__HTMLEditorInjected__) {
        console.log('[HTMLEditor] 已注入过，跳过');
        return;
    }
    window.__HTMLEditorInjected__ = true;

    console.log('[HTMLEditor] 开始初始化...');

    // 编辑器状态
    let isEditorActive = false;
    let editorOverlay = null;
    let toolbar = null;

    // ========== 撤销/重做 HistoryManager ==========
    const MAX_HISTORY = 50;
    const historyStack = [];      // 撤销栈
    const redoStack = [];         // 重做栈
    let isUndoRedoing = false;     // 正在执行撤销/重做时阻止记录
    let savePendingTimer = null;   // 输入节流定时器
    let lastCleanHTML = '';        // 上次保存的干净HTML（用于去重）

    // ========== 动态内容保护 ==========
    // Canvas/SVG 等动态渲染元素的内部状态无法通过 innerHTML 保留。
    // ★ 核心策略：DOM Diff（不触碰动态元素）
    //   - getCleanHTML(): 克隆DOM时将 canvas/svg 替换为占位符，生成"干净"HTML字符串
    //   - restoreCleanHTML(): 解析HTML到临时DOM，递归对比当前DOM，只修改非动态节点
    //   - canvas/svg 元素永远不被销毁或重建，ECharts 内部状态完整保留

    /** 动态内容选择器 —— 只匹配自身是动态渲染元素的标签 */
    const DYNAMIC_SELECTOR = 'canvas, svg, iframe, object, embed, video, audio';
    const DYNAMIC_MARKER_PREFIX = '__html_editor_dyn_';

    /**
     * 给页面中所有独立的动态渲染元素（canvas/svge等）分配稳定唯一ID
     * 返回 Map<id, Element> 映射，用于恢复时查找真实元素引用
     *
     * ★ 关键改进：直接给每个 canvas/svg 元素本身分配ID，而不是给包含它们的祖先容器分配
     */
    function assignDynamicIds() {
        const map = new Map(); // id -> element (真实的动态元素)
        let counter = 0;
        document.querySelectorAll(DYNAMIC_SELECTOR).forEach(el => {
            // 跳过编辑器UI内的动态元素（如工具栏可能有的图标svg）
            if (el.closest('.html-editor-toolbar')) return;

            const id = el.dataset.htmlEditorDynId || (DYNAMIC_MARKER_PREFIX + (counter++));
            if (!el.dataset.htmlEditorDynId) {
                el.dataset.htmlEditorDynId = id;
            }
            map.set(id, el);
        });
        return map;
    }

    /**
     * 获取"干净"的HTML快照 —— 只包含用户内容，不含编辑器UI和编辑器标记
     * 动态渲染元素（Canvas/SVG等）被替换为轻量级占位标记（保留周围所有文字内容）
     */
    function getCleanHTML() {
        // 先给真实DOM中的动态元素分配稳定ID
        assignDynamicIds();

        const clone = document.body.cloneNode(true);

        // 移除编辑器UI元素
        clone.querySelectorAll('.html-editor-toolbar, .html-editor-overlay, .html-editor-toast, .html-table-resizer, .html-resize-wrapper').forEach(el => el.remove());

        // ★ 将每个 canvas/svg 等动态元素替换为占位标记（只替换自身，保留周围内容）
        const dynamicElementsInClone = clone.querySelectorAll(DYNAMIC_SELECTOR);
        let markedCount = 0;
        dynamicElementsInClone.forEach(el => {
            const dynId = el.dataset.htmlEditorDynId;
            if (dynId) {
                const marker = document.createElement('div');
                marker.dataset.htmlEditorDynamicMarker = dynId;
                marker.setAttribute('data-dynamic-placeholder', 'true');
                marker.style.cssText = `display:inline-block;width:${el.offsetWidth}px;height:${el.offsetHeight}px;`;
                if (el.parentNode) {
                    el.parentNode.replaceChild(marker, el);
                }
                markedCount++;
            }
        });

        // 移除编辑器添加的class和属性（恢复为用户原始内容）
        clone.querySelectorAll('.html-editable').forEach(el => {
            el.classList.remove('html-editable');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        clone.querySelectorAll('[contenteditable]').forEach(el => {
            // 只移除编辑器添加的contenteditable，保留用户原本就有的
            if (!el.dataset.originalContenteditable) {
                el.removeAttribute('contenteditable');
            }
        });
        clone.querySelectorAll('.html-editable-table').forEach(el => {
            el.classList.remove('html-editable-table', 'html-resizable-table', 'html-table-resizable-initialized');
            if (!el.getAttribute('class')) el.removeAttribute('class');
            // ★ 恢复原始 border-collapse
            if (el.dataset.originalBorderCollapse) {
                el.style.borderCollapse = el.dataset.originalBorderCollapse;
                el.style.borderSpacing = '';
                delete el.dataset.originalBorderCollapse;
            }
            // ★ 移除编辑器添加的 data 属性
            delete el.dataset.tableId;
        });
        clone.querySelectorAll('.html-editable-image').forEach(el => {
            el.classList.remove('html-editable-image');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        clone.querySelectorAll('.container-selected, .cell-selected, .cell-multi-selected').forEach(el => {
            el.classList.remove('container-selected', 'cell-selected', 'cell-multi-selected');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        // 移除编辑器可能添加的data属性
        clone.querySelectorAll('[data-original-contenteditable]').forEach(el => {
            el.removeAttribute('data-original-contenteditable');
        });

        return clone.innerHTML;
    }

    /**
     * 获取干净的完整文档HTML（用于保存）
     * 在 getCleanHTML 基础上扩展为整个 document 级别，确保保存后不残留编辑器标记
     */
    function getCleanDocumentHTML() {
        const docClone = document.documentElement.cloneNode(true);

        // 移除编辑器UI元素
        docClone.querySelectorAll('.html-editor-toolbar, .html-editor-overlay, .html-editor-toast, .html-table-resizer, .html-resize-wrapper').forEach(el => el.remove());

        // 移除编辑器添加的class
        docClone.querySelectorAll('.html-editable').forEach(el => {
            el.classList.remove('html-editable');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        docClone.querySelectorAll('.html-editable-table').forEach(el => {
            el.classList.remove('html-editable-table', 'html-resizable-table', 'html-table-resizable-initialized');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        docClone.querySelectorAll('.html-editable-image').forEach(el => {
            el.classList.remove('html-editable-image');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        docClone.querySelectorAll('.container-selected, .cell-selected, .cell-multi-selected').forEach(el => {
            el.classList.remove('container-selected', 'cell-selected', 'cell-multi-selected');
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });

        // 移除编辑器添加的 contenteditable
        docClone.querySelectorAll('[contenteditable]').forEach(el => {
            if (!el.dataset.originalContenteditable) {
                el.removeAttribute('contenteditable');
            }
        });

        // 移除编辑器添加的data属性
        docClone.querySelectorAll('[data-original-contenteditable]').forEach(el => {
            el.removeAttribute('data-original-contenteditable');
        });
        docClone.querySelectorAll('[data-html-editor-dyn-id]').forEach(el => {
            el.removeAttribute('data-html-editor-dyn-id');
        });

        return '<!DOCTYPE html>\n' + docClone.outerHTML;
    }

    /**
     * 用干净的HTML恢复内容 —— DOM Diff 策略
     * ★ 核心思路：不使用 body.innerHTML 替换（那会销毁Canvas/ECharts等动态内容），
     *   而是解析目标HTML到临时DOM，然后递归对比当前DOM和目标DOM，
     *   只修改有差异的非动态节点，永远不触碰 canvas/svg 等动态元素。
     */
    function restoreCleanHTML(cleanHTML) {
        const dynamicCount = document.querySelectorAll(DYNAMIC_SELECTOR).length;
        console.log(`[HTMLEditor] 🔄 restoreCleanHTML(DOM diff): 输入len=${cleanHTML.length}, 动态元素数=${dynamicCount}`);

        // 1. 保存并移除编辑器UI（不在diff范围内）
        const currentToolbar = document.getElementById('html-editor-toolbar');
        const currentOverlay = document.getElementById('html-editor-overlay');
        const currentToasts = [...document.querySelectorAll('.html-editor-toast')];
        if (currentToolbar) currentToolbar.remove();
        if (currentOverlay) currentOverlay.remove();
        currentToasts.forEach(t => t.remove());

        // 2. 给当前DOM中的动态元素分配ID（标识用，确保diff能识别它们）
        assignDynamicIds();

        // 3. 解析目标HTML到临时容器
        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = cleanHTML;

        // 4. 执行DOM Diff — 递归对比，只修改非动态内容
        let changeCount = 0;
        diffChildren(document.body, tempContainer, () => changeCount++);

        // 5. 重新添加编辑器UI
        if (currentToolbar) document.body.appendChild(currentToolbar);
        if (currentOverlay) document.body.appendChild(currentOverlay);

        // 6. 重新标记可编辑元素和表格（diff会移除编辑器添加的class/属性）
        restoreEditableState();

        console.log(`[HTMLEditor] 🔄 DOM diff完成: ${changeCount}处变更, 动态元素未触碰`);
    }

    /** 检查节点是否为动态渲染元素（canvas/svg/iframe等） */
    function isDynamicElement(node) {
        return node && node.nodeType === Node.ELEMENT_NODE && node.matches(DYNAMIC_SELECTOR);
    }

    /** 检查节点是否为动态元素的占位标记（由getCleanHTML生成） */
    function isPlaceholderMarker(node) {
        return node && node.nodeType === Node.ELEMENT_NODE &&
               node.hasAttribute('data-dynamic-placeholder');
    }

    /**
     * 递归对比两个父节点的子节点列表，按位置逐一匹配
     * - 动态元素（canvas/svg）和占位标记（placeholder）→ 跳过，保持当前DOM不动
     * - 普通元素/文本 → diffNode 比较并应用差异
     * - 目标多余 → 插入克隆；当前多余 → 删除（跳过动态元素）
     */
    function diffChildren(currentParent, targetParent, onChange) {
        const curKids = [...currentParent.childNodes];
        const tgtKids = [...targetParent.childNodes];
        const len = Math.max(curKids.length, tgtKids.length);

        for (let i = 0; i < len; i++) {
            const cur = curKids[i];
            const tgt = tgtKids[i];

            // 只有目标没有当前 → 插入（跳过占位标记）
            if (!cur && tgt) {
                if (!isPlaceholderMarker(tgt)) {
                    currentParent.appendChild(tgt.cloneNode(true));
                    if (onChange) onChange();
                }
                continue;
            }

            // 只有当前没有目标 → 删除（跳过动态元素）
            if (cur && !tgt) {
                if (!isDynamicElement(cur)) {
                    cur.remove();
                    if (onChange) onChange();
                }
                continue;
            }

            if (!cur || !tgt) continue;

            // ★ 核心规则：动态元素和占位标记成对出现，跳过两者
            if (isDynamicElement(cur) || isPlaceholderMarker(tgt)) {
                continue; // 保持当前DOM不动
            }

            // 两个都是普通节点 → 递归diff
            diffNode(cur, tgt, onChange);
        }
    }

    /**
     * 对比两个节点（当前 vs 目标），应用差异
     * - 文本节点 → 更新 textContent
     * - 同标签元素 → 同步属性 + 递归 diffChildren
     * - 不同类型/标签 → 用目标克隆替换当前
     */
    function diffNode(current, target, onChange) {
        // 两个文本节点
        if (current.nodeType === Node.TEXT_NODE && target.nodeType === Node.TEXT_NODE) {
            if (current.textContent !== target.textContent) {
                current.textContent = target.textContent;
                if (onChange) onChange();
            }
            return;
        }

        // 两个元素节点
        if (current.nodeType === Node.ELEMENT_NODE && target.nodeType === Node.ELEMENT_NODE) {
            // 标签不同 → 直接替换
            if (current.tagName !== target.tagName) {
                const clone = target.cloneNode(true);
                current.parentNode.replaceChild(clone, current);
                if (onChange) onChange();
                return;
            }

            // 标签相同 → 同步属性
            if (syncAttributes(current, target)) {
                if (onChange) onChange();
            }

            // 递归对比子节点
            diffChildren(current, target, onChange);
            return;
        }

        // 类型不同（一个是文本，一个是元素）→ 替换
        const clone = target.cloneNode(true);
        current.parentNode.replaceChild(clone, current);
        if (onChange) onChange();
    }

    /**
     * 将目标元素的属性同步到当前元素
     * - 移除当前有但目标没有的属性
     * - 添加/更新目标有但当前没有/不同的属性
     * @returns {boolean} 是否有变更
     */
    function syncAttributes(current, target) {
        let changed = false;

        // 移除当前多余属性
        for (const attr of [...current.attributes]) {
            if (!target.hasAttribute(attr.name) && attr.name !== 'data-html-editor-dyn-id') {
                current.removeAttribute(attr.name);
                changed = true;
            }
        }

        // 添加/更新目标属性
        for (const attr of target.attributes) {
            if (current.getAttribute(attr.name) !== attr.value) {
                current.setAttribute(attr.name, attr.value);
                changed = true;
            }
        }

        return changed;
    }

    const historyManager = {
        /**
         * 保存当前状态到撤销栈
         * @param {string} label - 操作标签
         * @param {object} options - 选项
         * @param {boolean} options.force - 强制保存（跳过去重检查），用于工具栏显式操作
         */
        save(label, options = {}) {
            if (isUndoRedoing || !isEditorActive) return;
            const html = getCleanHTML();
            if (!options.force && html === lastCleanHTML) return; // 无变化则跳过（force模式跳过此检查）

            // 先清除 pending 的 debounced timer（防止同一操作被记录两次）
            clearTimeout(savePendingTimer);
            savePendingTimer = null;

            // 清空重做栈（新操作后重做失效）
            redoStack.length = 0;

            historyStack.push({ html, label: label || '编辑', timestamp: Date.now() });
            if (historyStack.length > MAX_HISTORY) historyStack.shift();

            console.log(`[HTMLEditor] 💾 save("${label}", force=${!!options.force}) | 栈深度=${historyStack.length} | html.len=${html.length} | 与上一次相同?${html === lastCleanHTML}`);

            lastCleanHTML = html;
            updateUndoRedoButtons();
        },

        /** 带节流的保存（适用于高频文本输入） */
        saveDebounced(label, delay) {
            if (isUndoRedoing || !isEditorActive) return;
            clearTimeout(savePendingTimer);
            savePendingTimer = setTimeout(() => this.save(label), delay || 600);
        },

        /** 取消 pending 的 debounced 保存 */
        cancelPending() {
            clearTimeout(savePendingTimer);
            savePendingTimer = null;
        },

        /**
         * 只更新 lastCleanHTML 基线（不push到栈）
         * 用在 execCommand 等显式操作之后，防止 input 事件将"操作后状态"重复入栈
         */
        updateBaseline() {
            if (isUndoRedoing || !isEditorActive) return;
            lastCleanHTML = getCleanHTML();
        },

        /** 撤销 */
        undo() {
            if (historyStack.length === 0) {
                console.warn('[HTMLEditor] undo() → 栈空，无法撤销');
                return false;
            }
            const current = getCleanHTML();

            // 把当前状态推入重做栈
            redoStack.push({ html: current, timestamp: Date.now() });

            // 弹出上一个状态恢复
            const prev = historyStack.pop();
            console.log(`[HTMLEditor] 🔙 撤销: "${prev.label}" | 栈深度=${historyStack.length} | prev.len=${prev.html.length} current.len=${current.length} | 相同?${prev.html === current}`);

            isUndoRedoing = true;
            try {
                restoreCleanHTML(prev.html);
                lastCleanHTML = prev.html;
                restoreFocus();
            } finally {
                isUndoRedoing = false;
            }
            updateUndoRedoButtons();
            showToast('已撤销: ' + prev.label, 'info');
            return true;
        },

        /** 重做 */
        redo() {
            if (redoStack.length === 0) return false;
            const current = getCleanHTML();

            // 把当前状态推回撤销栈
            historyStack.push({ html: current, timestamp: Date.now() });

            // 弹出重做栈中的状态
            const next = redoStack.pop();
            isUndoRedoing = true;
            try {
                restoreCleanHTML(next.html);
                lastCleanHTML = next.html;
                restoreFocus();
            } finally {
                isUndoRedoing = false;
            }
            updateUndoRedoButtons();
            showToast('已重做', 'info');
            return true;
        },

        /** 清空历史（编辑器关闭/打开时调用） */
        clear() {
            historyStack.length = 0;
            redoStack.length = 0;
            lastCleanHTML = '';
            clearTimeout(savePendingTimer);
            updateUndoRedoButtons();
        },

        canUndo() { return historyStack.length > 0; },
        canRedo() { return redoStack.length > 0; }
    };

    // ===== 调试：将历史栈暴露到 window，在 Console 输入 window.__history__ 即可查看 =====
    window.__history__ = {
        get stack() { return historyStack.map((h, i) => ({ idx: historyStack.length - i, label: h.label, time: new Date(h.timestamp).toLocaleTimeString() })); },
        get redoStack() { return redoStack.map((h, i) => ({ idx: i + 1, time: new Date(h.timestamp).toLocaleTimeString() })); },
        /** 列出页面中所有受保护的动态渲染元素 */
        get dynamicElements() {
            const result = [];
            document.querySelectorAll(DYNAMIC_SELECTOR).forEach(el => {
                if (!el.closest('.html-editor-toolbar')) {
                    result.push({ tag: el.tagName, dynId: el.dataset.htmlEditorDynId || '(未分配)', size: `${el.offsetWidth}x${el.offsetHeight}` });
                }
            });
            return result;
        },
        dump() {
            console.group('%c📋 撤销/重做历史栈', 'font-size:14px;font-weight:bold;color:#2196F3');
            console.table(this.stack);
            if (this.redoStack.length) {
                console.log('%c↪ 重做栈:', 'color:#4CAF50;font-weight:bold');
                console.table(this.redoStack);
            } else {
                console.log('重做栈: 空');
            }
            const dyn = this.dynamicElements;
            if (dyn.length) {
                console.log('%c📊 动态元素(Canvas/SVG):', 'color:#FF9800;font-weight:bold');
                console.table(dyn);
            } else {
                console.log('动态元素: 无');
            }
            console.groupEnd();
        }
    };

    /** 恢复innerHTML后被破坏的可编辑标记 */
    function restoreEditableState() {
        markEditableElements();
        // 恢复表格可调大小
        document.querySelectorAll('.html-editable-table').forEach(table => {
            makeTableResizable(table);
            setupTableCellEvents(table);
        });
    }

    /** innerHTML替换后恢复焦点，确保后续execCommand正常工作 */
    function restoreFocus() {
        // 优先聚焦第一个可编辑元素
        const firstEditable = document.querySelector('.html-editable');
        if (firstEditable) {
            // 将光标移到元素开头，让用户能继续编辑
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(firstEditable);
            range.collapse(true); // 折叠到起点
            sel.removeAllRanges();
            sel.addRange(range);
            firstEditable.focus();
        } else {
            // 回退：让body可聚焦
            document.body.setAttribute('contenteditable', 'true');
            document.body.focus();
        }
    }

    // ===== 选区保存/恢复（解决颜色选择器等导致选区丢失的问题）=====
    let _savedSelection = null;

    /** 保存当前文本选区 */
    function saveCurrentSelection() {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            _savedSelection = sel.getRangeAt(0).cloneRange();
        }
    }

    /** 恢复之前保存的选区 */
    function restoreSavedSelection() {
        if (_savedSelection) {
            try {
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(_savedSelection);
            } catch (e) {
                // 节点可能已被销毁，忽略
                console.warn('restoreSavedSelection failed:', e.message);
            }
        }
    }

    /** 更新撤销/重做按钮的禁用状态 */
    function updateUndoRedoButtons() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = !historyManager.canUndo();
        if (redoBtn) redoBtn.disabled = !historyManager.canRedo();
    }

    /** 使用 input 事件监听文本编辑（替代 MutationObserver，更精确无噪音） */
    let inputListener = null;
    function setupInputListener() {
        if (inputListener) return;
        inputListener = function(e) {
            if (!isEditorActive || isUndoRedoing) return;
            // 忽略编辑器UI内部的输入
            if (e.target.closest?.('.html-editor-toolbar')) return;
            if (e.target.closest?.('.html-editor-overlay')) return;
            historyManager.saveDebounced('文本编辑', 600);
        };
        document.addEventListener('input', inputListener);
    }

    function teardownInputListener() {
        if (inputListener) {
            document.removeEventListener('input', inputListener);
            inputListener = null;
        }
    }
    // ========== HistoryManager 结束 ==========

    // 监听来自popup的消息
    console.log('[HTMLEditor] 注册消息监听器...');
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        console.log('Received message:', request.action);
        try {
            switch (request.action) {
                case 'checkStatus':
                    console.log('Status check - isEditorActive:', isEditorActive);
                    sendResponse({isEditorActive: isEditorActive});
                    return true;
                case 'toggleEditor':
                    console.log('Toggle editor - current state:', isEditorActive);
                    if (isEditorActive) {
                        deactivateEditor();
                    } else {
                        activateEditor();
                    }
                    sendResponse({success: true});
                    return true;
                case 'saveDocument':
                    if (isEditorActive) {
                        saveDocument();
                        sendResponse({success: true});
                    } else {
                        sendResponse({success: false});
                    }
                    return true;
                default:
                    console.log('Unknown action:', request.action);
                    return false;
            }
        } catch (error) {
            console.error('Editor message error:', error);
            sendResponse({success: false, error: error.message});
            return true;
        }
    });

    // 激活编辑器
    function activateEditor() {
        console.log('activateEditor called');
        if (isEditorActive) {
            console.log('Editor already active, skipping');
            return;
        }

        try {
            console.log('Creating editor UI...');
            // 创建编辑器UI
            createEditorUI();

            console.log('Marking editable elements...');
            // 标记可编辑元素
            markEditableElements();

            console.log('Loading modules...');
            // 加载功能模块（异步，不阻塞）
            setTimeout(() => {
                try {
                    loadEditorModules();
                } catch (e) {
                    console.warn('Modules loading failed (non-critical):', e);
                }
            }, 100);

            isEditorActive = true;
            console.log('Editor activated successfully');

            // 初始化撤销/重做：记录初始状态
            lastCleanHTML = getCleanHTML();
            setupInputListener();
            updateUndoRedoButtons();

            // 通知popup状态变化
            notifyStatusChange();

            // 添加页面级提示
            showToast('编辑模式已开启', 'success');
        } catch (error) {
            console.error('Failed to activate editor:', error);
            showToast('编辑器启动失败: ' + error.message, 'error');
        }
    }

    // 加载功能模块（可选，表格调整已内置）
    function loadEditorModules() {
        // 如果模块已加载，跳过
        if (window.__editorModulesLoaded__) return;

        // 只加载形状和连接线模块（表格调整已内置）
        const modules = [
            'content/modules/shape-tool.js',
            'content/modules/connector.js'
        ];

        modules.forEach(modulePath => {
            try {
                const script = document.createElement('script');
                script.src = chrome.runtime.getURL(modulePath);
                script.onload = () => console.log(`Module loaded: ${modulePath}`);
                script.onerror = (e) => console.warn(`Module not available: ${modulePath} (non-critical)`);
                (document.head || document.documentElement).appendChild(script);
            } catch (error) {
                console.warn(`Error loading module ${modulePath} (non-critical):`, error);
            }
        });

        window.__editorModulesLoaded__ = true;
    }

    // 停用编辑器
    function deactivateEditor() {
        if (!isEditorActive) return;

        // 移除编辑器UI
        if (editorOverlay && editorOverlay.parentNode) {
            editorOverlay.parentNode.removeChild(editorOverlay);
        }
        if (toolbar && toolbar.parentNode) {
            toolbar.parentNode.removeChild(toolbar);
        }

        // 移除可编辑标记
        unmarkEditableElements();

        isEditorActive = false;
        editorOverlay = null;
        toolbar = null;

        // 清理撤销/重做历史和输入监听
        historyManager.clear();
        teardownInputListener();

        // 通知popup状态变化
        notifyStatusChange();

        showToast('编辑模式已关闭', 'info');
    }

    // 创建编辑器UI
    function createEditorUI() {
        console.log('Creating toolbar...');
        // 创建工具栏
        toolbar = document.createElement('div');
        toolbar.id = 'html-editor-toolbar';
        toolbar.className = 'html-editor-toolbar';
        toolbar.innerHTML = getToolbarHTML();
        document.body.appendChild(toolbar);
        console.log('Toolbar created');

        // 创建编辑器覆盖层（用于形状绘制等）
        editorOverlay = document.createElement('div');
        editorOverlay.id = 'html-editor-overlay';
        editorOverlay.className = 'html-editor-overlay';
        document.body.appendChild(editorOverlay);

        console.log('Binding toolbar events...');
        // 绑定工具栏事件
        bindToolbarEvents();
        console.log('UI creation complete');
    }

    // 获取工具栏HTML
    function getToolbarHTML() {
        return `
            <div class="toolbar-section">
                <span class="section-title">操作</span>
                <button class="tool-btn" id="undoBtn" title="撤销 (Ctrl+Z)" disabled>撤销</button>
                <button class="tool-btn" id="redoBtn" title="重做 (Ctrl+Y)" disabled>重做</button>
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section">
                <span class="section-title">文本</span>
                <button class="tool-btn" data-command="bold" title="加粗"><b>B</b></button>
                <button class="tool-btn" data-command="italic" title="斜体"><i>I</i></button>
                <button class="tool-btn" data-command="underline" title="下划线"><u>U</u></button>
                <button class="tool-btn" data-command="strikeThrough" title="删除线"><s>S</s></button>
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section">
                <span class="section-title">字体</span>
                <select class="tool-select" id="fontSizeSelect">
                    <option value="3">正常</option>
                    <option value="1">小</option>
                    <option value="4">较大</option>
                    <option value="5">大</option>
                    <option value="6">很大</option>
                    <option value="7">超大</option>
                </select>
                <input type="color" class="tool-color" id="textColor" value="#000000" title="文字颜色">
                <input type="color" class="tool-color" id="bgColor" value="#ffffff" title="背景颜色">
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section">
                <span class="section-title">段落</span>
                <button class="tool-btn" data-command="formatBlock" data-value="h2" title="标题">H2</button>
                <button class="tool-btn" data-command="formatBlock" data-value="h3" title="副标题">H3</button>
                <button class="tool-btn" data-command="insertUnorderedList" title="无序列表">列表</button>
                <button class="tool-btn" data-command="insertOrderedList" title="有序列表">序号</button>
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section">
                <span class="section-title">插入</span>
                <button class="tool-btn" id="insertTableBtn" title="插入表格">表格</button>
                <button class="tool-btn" id="insertImageBtn" title="插入图片">图片</button>
                <button class="tool-btn" id="insertRectBtn" title="矩形">矩形</button>
                <button class="tool-btn" id="insertCircleBtn" title="圆形">圆形</button>
                <button class="tool-btn" id="insertArrowBtn" title="箭头">箭头</button>
                <button class="tool-btn" id="insertConnectorBtn" title="连接线">连线</button>
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section">
                <span class="section-title">表格</span>
                <button class="tool-btn" id="addTableRowBtn" title="添加行">+ 行</button>
                <button class="tool-btn" id="addTableColBtn" title="添加列">+ 列</button>
                <button class="tool-btn" id="delTableRowBtn" title="删除行">- 行</button>
                <button class="tool-btn" id="delTableColBtn" title="删除列">- 列</button>
                <button class="tool-btn" id="mergeCellsBtn" title="合并单元格（选中多个后点击）">合并</button>
                <button class="tool-btn" id="unmergeCellsBtn" title="拆分单元格">拆分</button>
                <input type="color" class="tool-color" id="cellBgColor" value="#ffffff" title="单元格背景色">
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section">
                <span class="section-title">编辑</span>
                <button class="tool-btn tool-btn-danger" id="deleteContainerBtn" title="删除选中元素">删除</button>
                <button class="tool-btn" id="copyContainerBtn" title="复制选中元素">复制</button>
                <button class="tool-btn" id="pasteContainerBtn" title="粘贴元素">粘贴</button>
            </div>
            <div class="toolbar-divider"></div>
            <div class="toolbar-section toolbar-section--end">
                <button class="tool-btn tool-btn-primary" id="saveBtn" title="保存文档">保存</button>
            </div>
        `;
    }

    // 绑定工具栏事件
    function bindToolbarEvents() {
        // ===== 撤销/重做按钮 =====
        document.getElementById('undoBtn').addEventListener('click', () => historyManager.undo());
        document.getElementById('redoBtn').addEventListener('click', () => historyManager.redo());

        // ===== 键盘快捷键 =====
        document.addEventListener('keydown', function(e) {
            if (!isEditorActive) return;
            // 在编辑区域内且非特殊输入框时拦截
            const tag = e.target.tagName.toLowerCase();
            const isInput = ['input', 'textarea', 'select'].includes(tag);
            const isContentEditable = e.target.isContentEditable;

            // Ctrl+Z 撤销
            if (e.ctrlKey && !e.shiftKey && e.key === 'z') {
                e.preventDefault();
                historyManager.undo();
                return;
            }
            // Ctrl+Y 或 Ctrl+Shift+Z 重做
            if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z')) {
                e.preventDefault();
                historyManager.redo();
                return;
            }
        });

        // 文本格式按钮
        toolbar.querySelectorAll('[data-command]').forEach(btn => {
            btn.addEventListener('click', function() {
                historyManager.cancelPending();
                historyManager.save(this.dataset.command || '格式', { force: true }); // ★ 强制保存操作前状态
                const command = this.dataset.command;
                const value = this.dataset.value || null;
                document.execCommand(command, false, value);
                this.classList.toggle('active', document.queryCommandState(command));
                historyManager.updateBaseline(); // ★ 更新基线，防止input事件重复记录
            });
        });

        // 字体大小
        const fontSizeSelect = document.getElementById('fontSizeSelect');
        fontSizeSelect.addEventListener('mousedown', saveCurrentSelection);
        fontSizeSelect.addEventListener('focus', saveCurrentSelection);
        fontSizeSelect.addEventListener('change', function() {
            restoreSavedSelection();
            historyManager.cancelPending();
            historyManager.save('字体大小', { force: true });
            applyFontSize(this.value);
            historyManager.updateBaseline();
        });

        // 颜色选择器（点击时保存选区，确认颜色后恢复选区再执行）
        ['textColor', 'bgColor'].forEach(id => {
            const el = document.getElementById(id);
            el.addEventListener('mousedown', saveCurrentSelection);   // 点击颜色框瞬间保存选区
            el.addEventListener('focus', saveCurrentSelection);
            el.addEventListener('change', function() {
                console.log(`[HTMLEditor] 🎨 ${id} change → value=${this.value}, savedSelection=${!!_savedSelection}`);
                restoreSavedSelection();  // 恢复选区后再执行命令
                historyManager.cancelPending();
                historyManager.save(id === 'textColor' ? '文字颜色' : '背景颜色', { force: true });
                const cmd = id === 'textColor' ? 'foreColor' : 'hiliteColor';
                const success = document.execCommand(cmd, false, this.value);
                console.log(`[HTMLEditor] 🎨 execCommand("${cmd}", "${this.value}") → success=${success}`);
                historyManager.updateBaseline();
            });
        });

        // 保存按钮
        document.getElementById('saveBtn').addEventListener('click', saveDocument);

        // 表格操作按钮（需要选中表格）
        document.getElementById('addTableRowBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('添加行', { force: true }); tableOperation('addRow'); historyManager.updateBaseline(); });
        document.getElementById('addTableColBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('添加列', { force: true }); tableOperation('addCol'); historyManager.updateBaseline(); });
        document.getElementById('delTableRowBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('删除行', { force: true }); tableOperation('delRow'); historyManager.updateBaseline(); });
        document.getElementById('delTableColBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('删除列', { force: true }); tableOperation('delCol'); historyManager.updateBaseline(); });

        // 合并/拆分单元格
        document.getElementById('mergeCellsBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('合并单元格', { force: true }); mergeCells(); historyManager.updateBaseline(); });
        document.getElementById('unmergeCellsBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('拆分单元格', { force: true }); unmergeCells(); historyManager.updateBaseline(); });

        // 单元格背景色
        const cellBgColorEl = document.getElementById('cellBgColor');
        cellBgColorEl.addEventListener('mousedown', saveCurrentSelection);
        cellBgColorEl.addEventListener('focus', saveCurrentSelection);
        cellBgColorEl.addEventListener('change', function() {
            restoreSavedSelection();
            historyManager.cancelPending();
            historyManager.save('单元格背景色', { force: true });
            setTableCellBackground(this.value);
            historyManager.updateBaseline();
        });

        // 监听单元格点击，更新颜色选择器的值
        document.addEventListener('click', function(e) {
            const cell = e.target.closest('td, th');
            if (cell && !cell.closest('.html-editor-toolbar')) {
                const bgColor = window.getComputedStyle(cell).backgroundColor;
                if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
                    const hex = rgbToHex(bgColor);
                    document.getElementById('cellBgColor').value = hex;
                }
            }
        });

        // 插入按钮
        document.getElementById('insertTableBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('插入表格', { force: true }); insertTable(); historyManager.updateBaseline(); });
        document.getElementById('insertImageBtn').addEventListener('click', insertImage); // insertImage 内部有自己的 save
        document.getElementById('insertRectBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('插入矩形', { force: true }); insertShape('rect'); historyManager.updateBaseline(); });
        document.getElementById('insertCircleBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('插入圆形', { force: true }); insertShape('circle'); historyManager.updateBaseline(); });
        document.getElementById('insertArrowBtn').addEventListener('click', () => { historyManager.cancelPending(); historyManager.save('插入箭头', { force: true }); insertShape('arrow'); historyManager.updateBaseline(); });
        document.getElementById('insertConnectorBtn').addEventListener('click', activateConnectorMode);

        // 容器操作按钮
        document.getElementById('deleteContainerBtn').addEventListener('click', deleteSelectedContainer);
        document.getElementById('copyContainerBtn').addEventListener('click', copySelectedContainer);
        document.getElementById('pasteContainerBtn').addEventListener('click', pasteContainer);

        // 监听选区变化更新按钮状态
        document.addEventListener('selectionchange', updateButtonStates);

        // 设置容器选择功能
        setupContainerSelection();
        setupTableMultiSelect();

        // ★ 设置表格单元格智能粘贴（Excel/表格数据展开粘贴）
        setupSmartTablePaste();
    }

    // 当前选中的容器
    let selectedContainer = null;
    let copiedContainer = null;
    let activeResizeHandles = null;  // 当前激活的 resize 手柄包裹元素
    let resizeDragState = null;      // 当前 resize 拖拽状态

    // 容器多选
    let selectedCells = [];

    // 设置容器选择功能
    function setupContainerSelection() {
        document.addEventListener('click', function(e) {
            if (!isEditorActive) return;
            if (e.target.closest('.html-editor-toolbar')) return;
            if (e.target.closest('td, th')) return; // 让表格单元格有自己的处理

            const container = findContainer(e.target);
            if (container && !container.closest('.html-editor-toolbar')) {
                selectContainer(container);
            }
        });

        // 支持ESC键取消选择
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && selectedContainer) {
                clearContainerSelection();
            }
            // Ctrl+C 复制
            if (e.ctrlKey && e.key === 'c' && selectedContainer) {
                e.preventDefault();
                copySelectedContainer();
            }
            // Ctrl+V 粘贴（编辑器内部复制粘贴，优先于浏览器默认粘贴）
            if (e.ctrlKey && e.key === 'v' && copiedContainer) {
                e.preventDefault();
                e.stopPropagation();
                pasteContainer();
            }
            // Delete 删除
            if (e.key === 'Delete' && selectedContainer) {
                deleteSelectedContainer();
            }
        });
    }

    // 查找容器元素
    // ★ 改进：优先返回"有意义的块级容器"而非内联/叶级元素
    //   例如点击 <div><p>文字</p></div> 中的文字，应返回 div 而非 p
    const BLOCK_CONTAINERS = ['div', 'table', 'section', 'article', 'main', 'header', 'footer', 'aside', 'figure'];
    const LEAF_CONTAINERS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol'];

    function findContainer(element) {
        const ALL_CONTAINERS = [...BLOCK_CONTAINERS, ...LEAF_CONTAINERS, 'li', 'img'];

        let el = element;
        let firstLeafMatch = null;  // 第一个匹配的叶级容器（p/h/div等）
        let firstBlockMatch = null; // 第一个匹配的块级容器（div/table等）

        while (el && el !== document.body && el !== document.documentElement) {
            const tag = el.tagName.toLowerCase();

            if (ALL_CONTAINERS.includes(tag)) {
                if (!firstLeafMatch) {
                    firstLeafMatch = el;
                }
                if (BLOCK_CONTAINERS.includes(tag) && !firstBlockMatch) {
                    firstBlockMatch = el;
                }

                // 对于 li，返回其父级 ul/ol
                if (tag === 'li') {
                    const parent = el.parentElement;
                    if (parent && ['ul', 'ol'].includes(parent.tagName.toLowerCase())) {
                        return parent;
                    }
                    return el;
                }

                // 如果找到了 img，直接返回
                if (tag === 'img') {
                    return el;
                }

                // ★ 关键改进：如果当前是叶级容器(p/h)，检查它的直接父级是否也是容器
                //   如果父级也是有效容器且不是 body，优先返回父级块级容器
                //   这样 <div><p>文本</p></div> 点击文本时返回 div 而不是 p
                if (LEAF_CONTAINERS.includes(tag)) {
                    const parent = el.parentElement;
                    if (parent && parent !== document.body) {
                        const parentTag = parent.tagName.toLowerCase();
                        // 父级是块级容器 → 返回父级
                        if (BLOCK_CONTAINERS.includes(parentTag)) {
                            return parent;
                        }
                        // 父级也是叶级容器 → 停在当前（避免无限制上浮）
                        if (LEAF_CONTAINERS.includes(parentTag)) {
                            return el;
                        }
                    }
                    return el;
                }

                // 块级容器(div/table 等) → 直接返回
                if (BLOCK_CONTAINERS.includes(tag)) {
                    return el;
                }

                return el;
            }

            el = el.parentElement;
        }

        // 兜底：如果没找到叶级但找到了块级，返回块级
        return firstBlockMatch || firstLeafMatch || null;
    }

    // 选中容器
    function selectContainer(container) {
        // 清除之前的选择
        clearContainerSelection();

        selectedContainer = container;
        container.classList.add('container-selected');

        // 对图片和形状显示 resize 手柄
        if (isResizableElement(container)) {
            showResizeHandles(container);
        }

        // 滚动到可见
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // 判断元素是否支持 resize（图片、形状）
    function isResizableElement(el) {
        if (!el) return false;
        return el.tagName === 'IMG' || el.classList.contains('html-shape');
    }

    // 显示 resize 手柄（使用 fixed 定位，适用于所有元素类型包括 void 元素如 img）
    function showResizeHandles(element) {
        removeResizeHandles();

        const wrapper = document.createElement('div');
        wrapper.className = 'html-resize-wrapper';

        const directions = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        directions.forEach(dir => {
            const handle = document.createElement('div');
            handle.className = `html-resize-handle ${dir}`;
            handle.dataset.resizeDir = dir;
            wrapper.appendChild(handle);
        });

        document.body.appendChild(wrapper);

        // 创建滚动/缩放监听器
        const scrollHandler = () => positionResizeWrapper();
        document.addEventListener('scroll', scrollHandler, true);
        const resizeObserver = new ResizeObserver(() => positionResizeWrapper());
        resizeObserver.observe(element);

        activeResizeHandles = { wrapper, element, scrollHandler, resizeObserver };
        positionResizeWrapper();

        // 监听 resize 手柄拖拽
        wrapper.querySelectorAll('.html-resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', onResizeHandleMouseDown);
        });
    }

    // 更新 resize 包裹层位置（fixed 定位，使用 getBoundingClientRect）
    function positionResizeWrapper() {
        if (!activeResizeHandles) return;
        const { wrapper, element } = activeResizeHandles;
        const rect = element.getBoundingClientRect();
        wrapper.style.left = rect.left + 'px';
        wrapper.style.top = rect.top + 'px';
        wrapper.style.width = rect.width + 'px';
        wrapper.style.height = rect.height + 'px';
    }

    // 移除 resize 手柄
    function removeResizeHandles() {
        if (activeResizeHandles) {
            activeResizeHandles.wrapper.remove();
            document.removeEventListener('scroll', activeResizeHandles.scrollHandler, true);
            activeResizeHandles.resizeObserver.disconnect();
            activeResizeHandles = null;
        }
    }

    // resize 手柄 mousedown 事件
    function onResizeHandleMouseDown(e) {
        if (!activeResizeHandles) return;
        e.preventDefault();
        e.stopPropagation();

        const element = activeResizeHandles.element;
        const dir = e.target.dataset.resizeDir;
        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = element.offsetWidth;
        const startHeight = element.offsetHeight;

        resizeDragState = { dir, startX, startY, startWidth, startHeight };

        historyManager.save('调整大小', { force: true });

        document.addEventListener('mousemove', onResizeMouseMove);
        document.addEventListener('mouseup', onResizeMouseUp);
        document.body.style.userSelect = 'none';
    }

    // resize 拖拽中
    function onResizeMouseMove(e) {
        if (!resizeDragState || !activeResizeHandles) return;

        const element = activeResizeHandles.element;
        const { dir, startX, startY, startWidth, startHeight } = resizeDragState;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        let newWidth = startWidth;
        let newHeight = startHeight;

        // 根据方向计算新尺寸
        if (dir.includes('e')) { newWidth = Math.max(30, startWidth + deltaX); }
        if (dir.includes('w')) { newWidth = Math.max(30, startWidth - deltaX); }
        if (dir.includes('s')) { newHeight = Math.max(30, startHeight + deltaY); }
        if (dir.includes('n')) { newHeight = Math.max(30, startHeight - deltaY); }

        element.style.width = newWidth + 'px';
        element.style.height = newHeight + 'px';

        positionResizeWrapper();
    }

    // resize 拖拽结束
    function onResizeMouseUp() {
        if (resizeDragState) {
            historyManager.updateBaseline();
            resizeDragState = null;
        }
        document.removeEventListener('mousemove', onResizeMouseMove);
        document.removeEventListener('mouseup', onResizeMouseUp);
        document.body.style.userSelect = '';
    }

    // 清除容器选择
    function clearContainerSelection() {
        removeResizeHandles();
        if (selectedContainer) {
            selectedContainer.classList.remove('container-selected');
            selectedContainer = null;
        }
        document.querySelectorAll('.container-selected').forEach(el => {
            el.classList.remove('container-selected');
        });
    }

    // 删除选中的容器
    function deleteSelectedContainer() {
        if (!selectedContainer) {
            showToast('请先选择要删除的元素', 'warning');
            return;
        }

        if (confirm('确定要删除选中的元素吗？')) {
            historyManager.cancelPending();
            historyManager.save('删除元素', { force: true });
            removeResizeHandles();
            const parent = selectedContainer.parentElement;
            selectedContainer.remove();
            selectedContainer = null;
            historyManager.updateBaseline();
            showToast('已删除', 'success');
        }
    }

    // 复制选中的容器
    function copySelectedContainer() {
        if (!selectedContainer) {
            showToast('请先选择要复制的元素', 'warning');
            return;
        }

        // ★ 用 outerHTML 序列化而非 cloneNode，避免 Canvas/SVG 动态内容丢失
        // cloneNode(true) 只会复制 DOM 结构和属性，不会复制：
        //   - Canvas 的渲染像素数据（toDataURL 能保留）
        //   - ECharts 等库绑定的运行时实例（无法完全恢复，但至少保留 DOM）
        const container = selectedContainer;

        // 对内部所有 Canvas 先做快照（将像素数据转为 data URL 的 img 替代）
        const canvasesInCopy = container.querySelectorAll('canvas');
        const canvasSnapshots = new Map(); // original element -> dataURL

        canvasesInCopy.forEach(canvas => {
            try {
                const dataURL = canvas.toDataURL('image/png');
                canvasSnapshots.set(canvas, dataURL);
                console.log(`[HTMLEditor] copyContainer: Canvas 快照成功 (${canvas.offsetWidth}x${canvas.offsetHeight})`);
            } catch (e) {
                console.warn(`[HTMLEditor] copyContainer: Canvas 快照失败 (可能跨域 tainted)`, e.message);
            }
        });

        // 序列化 HTML
        copiedContainer = {
            html: container.outerHTML,
            tagName: container.tagName,
            hasDynamicElements: canvasesInCopy.length > 0 || !!container.querySelector(DYNAMIC_SELECTOR),
            canvasSnapshots: canvasSnapshots  // 存储 Canvas 快照用于粘贴时还原
        };

        console.log(`[HTMLEditor] copySelectedContainer: ${container.tagName} (len=${copiedContainer.html.length}, canvases=${canvasesInCopy.length}, dynamic=${copiedContainer.hasDynamicElements})`);
        showToast('已复制，可以粘贴或使用Ctrl+V', 'success');
    }

    // 粘贴容器
    function pasteContainer() {
        if (!copiedContainer) {
            showToast('请先复制元素', 'warning');
            return;
        }

        historyManager.cancelPending();
        historyManager.save('粘贴元素', { force: true });

        // ★ 从序列化的 HTML 重建 DOM（而非再次 cloneNode）
        let clone;

        if (typeof copiedContainer === 'object' && copiedContainer.html) {
            // 新版格式：用 outerHTML 解析
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = copiedContainer.html;
            clone = tempDiv.firstElementChild;

            // ★ 还原 Canvas 快照：将之前保存的 data URL 写回新 canvas / 替换为 img
            if (copiedContainer.hasDynamicElements && copiedContainer.canvasSnapshots && copiedContainer.canvasSnapshots.size > 0) {
                const newCanvases = clone.querySelectorAll('canvas');
                copiedContainer.canvasSnapshots.forEach((dataURL, originalCanvas) => {
                    // 通过匹配位置或 ID 找到对应的新 canvas
                    const idx = Array.from(originalCanvas.parentElement.querySelectorAll('canvas')).indexOf(originalCanvas);
                    const newParent = clone.querySelector(`:scope > *, :scope > * > *`); // 尝试找到包含 canvas 的父级

                    // 更可靠的方式：按顺序匹配
                    const targetCanvas = newCanvases[idx];
                    if (targetCanvas) {
                        try {
                            const ctx = targetCanvas.getContext('2d');
                            if (ctx) {
                                const img = new Image();
                                img.onload = function() { ctx.drawImage(img, 0, 0); };
                                img.src = dataURL;
                                console.log('[HTMLEditor] pasteContainer: Canvas 快照还原成功');
                            }
                        } catch (e) {
                            console.warn('[HTMLEditor] pasteContainer: Canvas 还原失败', e.message);
                        }
                    }
                });
            }
        } else {
            // 兼容旧格式（不应触发，但做兜底）
            clone = copiedContainer.cloneNode(true);
        }

        if (!clone) {
            showToast('粘贴失败：无法重建元素', 'error');
            return;
        }

        // 插入位置
        if (selectedContainer) {
            // 插入到当前选中元素之后
            selectedContainer.parentElement.insertBefore(clone, selectedContainer.nextSibling);
        } else {
            // 插入到文档末尾
            document.body.appendChild(clone);
        }

        showToast('已粘贴', 'success');
        historyManager.updateBaseline();

        // 选中新粘贴的元素
        setTimeout(() => selectContainer(clone), 100);

        // ★ 如果粘贴内容包含动态元素，提示用户
        if (copiedContainer.hasDynamicElements) {
            setTimeout(() => showToast('注意：图表等动态元素可能需要刷新页面后重新加载', 'info'), 500);
        }
    }

    // 设置表格多选功能
    function setupTableMultiSelect() {
        let isSelecting = false;
        let startCell = null;

        document.addEventListener('mousedown', function(e) {
            // 跳过表格调整手柄的点击，避免干扰 resize 拖拽
            if (e.target.closest('.html-table-resizer')) return;

            const cell = e.target.closest('td, th');
            if (cell && !cell.closest('.html-editor-toolbar')) {
                isSelecting = true;
                startCell = cell;

                // 按住Ctrl键可以多选
                if (!e.ctrlKey && !e.metaKey) {
                    clearCellSelection();
                }

                toggleCellSelection(cell);
            }
        });

        document.addEventListener('mouseover', function(e) {
            if (!isSelecting) return;
            const cell = e.target.closest('td, th');
            if (cell && startCell) {
                selectCellRange(startCell, cell);
            }
        });

        document.addEventListener('mouseup', function() {
            isSelecting = false;
            startCell = null;
        });
    }

    // 切换单元格选择状态
    function toggleCellSelection(cell) {
        if (selectedCells.includes(cell)) {
            selectedCells = selectedCells.filter(c => c !== cell);
            cell.classList.remove('cell-multi-selected');
        } else {
            selectedCells.push(cell);
            cell.classList.add('cell-multi-selected');
        }
    }

    // 清除单元格选择
    function clearCellSelection() {
        selectedCells.forEach(cell => {
            cell.classList.remove('cell-multi-selected');
        });
        selectedCells = [];
    }

    // 选择单元格范围
    function selectCellRange(startCell, endCell) {
        const startTable = startCell.closest('table');
        const endTable = endCell.closest('table');

        if (startTable !== endTable) return;

        const startRow = startCell.closest('tr');
        const endRow = endCell.closest('tr');

        const table = startTable;
        const rows = Array.from(table.rows);

        const startRowIndex = rows.indexOf(startRow);
        const endRowIndex = rows.indexOf(endRow);

        const startColIndex = getCellIndex(startCell);
        const endColIndex = getCellIndex(endCell);

        const minRow = Math.min(startRowIndex, endRowIndex);
        const maxRow = Math.max(startRowIndex, endRowIndex);
        const minCol = Math.min(startColIndex, endColIndex);
        const maxCol = Math.max(startColIndex, endColIndex);

        clearCellSelection();

        for (let i = minRow; i <= maxRow; i++) {
            for (let j = minCol; j <= maxCol; j++) {
                const cell = rows[i].cells[j];
                if (cell) {
                    selectedCells.push(cell);
                    cell.classList.add('cell-multi-selected');
                }
            }
        }
    }

    // 获取单元格在行中的索引
    function getCellIndex(cell) {
        return Array.from(cell.closest('tr').cells).indexOf(cell);
    }

    // 更新按钮状态
    function updateButtonStates() {
        toolbar.querySelectorAll('[data-command]').forEach(btn => {
            const command = btn.dataset.command;
            if (document.queryCommandSupported(command)) {
                btn.classList.toggle('active', document.queryCommandState(command));
            }
        });
    }

    // 标记可编辑元素
    function markEditableElements() {
        const editableSelectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'li', 'td', 'th', 'div'];
        const elements = document.querySelectorAll(editableSelectors.join(','));

        elements.forEach(el => {
            // 检查是否在工具栏内
            if (el.closest('.html-editor-toolbar')) return;
            // 排除 resizer div，避免 contenteditable 覆盖导致拖拽失效
            if (el.classList.contains('html-table-resizer')) return;

            el.classList.add('html-editable');
            el.contentEditable = 'true';
        });

        // 给表格添加特殊样式
        document.querySelectorAll('table').forEach(table => {
            if (!table.closest('.html-editor-toolbar')) {
                table.classList.add('html-editable-table');
                makeTableResizable(table);
                setupTableCellEvents(table);
            }
        });

        // 给图片添加可点击样式
        document.querySelectorAll('img').forEach(img => {
            if (!img.closest('.html-editor-toolbar')) {
                img.classList.add('html-editable-image');
            }
        });
    }

    // 取消可编辑标记
    function unmarkEditableElements() {
        document.querySelectorAll('.html-editable').forEach(el => {
            el.classList.remove('html-editable');
            el.contentEditable = 'false';
        });

        document.querySelectorAll('.html-editable-table').forEach(table => {
            table.classList.remove('html-editable-table');
            removeTableResizer(table);
        });

        document.querySelectorAll('.html-editable-image').forEach(img => {
            img.classList.remove('html-editable-image');
        });
    }

    // 表格操作
    function tableOperation(operation) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;

        const cell = selection.anchorNode.parentElement?.closest('td, th');
        if (!cell) {
            showToast('请先点击表格中的单元格', 'warning');
            return;
        }

        const table = cell.closest('table');
        if (!table) return;

        switch (operation) {
            case 'addRow':
                addTableRow(table);
                break;
            case 'addCol':
                addTableColumn(table);
                break;
            case 'delRow':
                deleteTableRow(table, cell);
                break;
            case 'delCol':
                deleteTableColumn(table, cell);
                break;
        }
    }

    function addTableRow(table) {
        const tbody = table.querySelector('tbody') || table;
        const firstRow = tbody.querySelector('tr');
        if (!firstRow) return;

        const newRow = firstRow.cloneNode(true);
        newRow.querySelectorAll('td, th').forEach(cell => {
            cell.textContent = '';
            cell.contentEditable = 'true';
        });
        tbody.appendChild(newRow);
        makeTableResizable(table);
        showToast('已添加行', 'success');
    }

    function addTableColumn(table) {
        Array.from(table.rows).forEach(row => {
            const firstCell = row.cells[0];
            if (firstCell) {
                const newCell = firstCell.cloneNode(false);
                newCell.textContent = '';
                newCell.contentEditable = 'true';
                row.appendChild(newCell);
            }
        });
        makeTableResizable(table);
        showToast('已添加列', 'success');
    }

    function deleteTableRow(table, cell) {
        const row = cell.closest('tr');
        const tbody = row.closest('tbody') || table;
        if (tbody.rows.length > 1) {
            row.remove();
            showToast('已删除行', 'success');
        } else {
            showToast('至少保留一行', 'warning');
        }
    }

    function deleteTableColumn(table, cell) {
        const cellIndex = cell.cellIndex;
        if (table.rows[0].cells.length > 1) {
            Array.from(table.rows).forEach(row => {
                row.deleteCell(cellIndex);
            });
            showToast('已删除列', 'success');
        } else {
            showToast('至少保留一列', 'warning');
        }
    }

    // ========== 合并/拆分单元格 ==========

    /**
     * 合并选中的多个单元格为一个
     * 支持两种使用方式：
     *   1. 多选（Ctrl+点击 / 拖拽框选）多个单元格后点击合并按钮
     *   2. 选中单个已合并的单元格时，自动检测其覆盖区域进行重新合并（刷新）
     */
    function mergeCells() {
        let cellsToMerge;

        if (selectedCells.length >= 2) {
            // 方式1：多选模式 — 使用 selectedCells
            cellsToMerge = [...selectedCells];
        } else {
            // 方式2：单单元格 — 检查是否已有选中单元格
            const selection = window.getSelection();
            if (!selection.rangeCount) {
                showToast('请先选中要合并的单元格（按住Ctrl点击多个，或拖拽选择）', 'warning');
                return;
            }
            const anchorNode = selection.anchorNode;
            const cell = anchorNode.nodeType === Node.TEXT_NODE ?
                anchorNode.parentElement.closest('td, th') :
                anchorNode.closest('td, th');
            if (!cell) {
                showToast('请先在表格中选中单元格', 'warning');
                return;
            }

            if (selectedCells.length === 0) {
                showToast('请先选中至少2个单元格（按住Ctrl点击多个，或拖拽选择）', 'warning');
                return;
            }
            cellsToMerge = [cell];
        }

        if (cellsToMerge.length < 2) {
            showToast('请至少选中2个单元格才能合并', 'warning');
            return;
        }

        // 确保所有单元格属于同一表格
        const table = cellsToMerge[0].closest('table');
        if (!table || cellsToMerge.some(c => c.closest('table') !== table)) {
            showToast('不能跨表格合并', 'warning');
            return;
        }

        // 计算选中区域的行列范围
        const rows = Array.from(table.rows);
        let minRow = Infinity, maxRow = -1, minCol = Infinity, maxCol = -1;

        cellsToMerge.forEach(cell => {
            const rowIdx = rows.indexOf(cell.parentElement);
            const colIdx = getCellIndex(cell);
            minRow = Math.min(minRow, rowIdx);
            maxRow = Math.max(maxRow, rowIdx);
            minCol = Math.min(minCol, colIdx);
            maxCol = Math.max(maxCol, colIdx);
        });

        // 验证选中区域是否为完整的矩形（无空洞）
        const expectedCount = (maxRow - minRow + 1) * (maxCol - minCol + 1);

        // 检查区域内每个位置是否有被选中的单元格（考虑已有的colspan/rowspan）
        let actualCovered = 0;
        for (let r = minRow; r <= maxRow; r++) {
            for (let c = minCol; c <= maxCol; c++) {
                const cellAtPos = getCellAtPosition(rows, r, c);
                if (cellAtPos && cellsToMerge.includes(cellAtPos)) {
                    actualCovered++;
                }
            }
        }

        if (actualCovered < expectedCount) {
            showToast('所选单元格不构成完整矩形区域，请用拖拽或Ctrl+点击连续选择', 'warning');
            return;
        }

        // ★ 执行合并：保留左上角单元格，移除其他单元格
        const topLeftCell = cellsToMerge.find(c => {
            const r = rows.indexOf(c.parentElement);
            return r === minRow && getCellIndex(c) === minCol;
        }) || cellsToMerge[0];

        const mergeRows = maxRow - minRow + 1;
        const mergeCols = maxCol - minCol + 1;

        // 收集被合并单元格的文本内容（按顺序拼接）
        let mergedText = '';
        for (let r = minRow; r <= maxRow; r++) {
            const rowTexts = [];
            for (let c = minCol; c <= maxCol; c++) {
                const cellAtPos = getCellAtPosition(rows, r, c);
                if (cellAtPos && cellAtPos !== topLeftCell) {
                    const txt = cellAtPos.textContent.trim();
                    if (txt) rowTexts.push(txt);
                } else if (getCellAtPosition(rows, r, c) === topLeftCell) {
                    const txt = topLeftCell.textContent.trim();
                    if (txt) rowTexts.push(txt);
                }
            }
            if (rowTexts.length > 0) {
                mergedText += (mergedText ? '\n' : '') + rowTexts.join('\t');
            }
        }

        // 设置 colspan 和 rowspan
        if (mergeCols > 1) topLeftCell.colSpan = mergeCols;
        if (mergeRows > 1) topLeftCell.rowSpan = mergeRows;

        // 用合并后的内容替换左上角单元格文本
        topLeftCell.textContent = mergedText || topLeftCell.textContent;
        if (!topLeftCell.hasAttribute('contenteditable')) {
            topLeftCell.contentEditable = 'true';
        }

        // 移除其他被合并的单元格
        cellsToMerge.forEach(cell => {
            if (cell !== topLeftCell) cell.remove();
        });

        // 清理空行（如果某行的所有 td 都被移除了）
        rows.forEach(row => {
            if (row.cells.length === 0) row.remove();
        });

        // 刷新 resizer 和选中状态
        makeTableResizable(table);
        clearCellSelection();

        console.log(`[HTMLEditor] mergeCells: 合并 ${mergeRows}行×${mergeCols}列 → colspan=${topLeftCell.colSpan}, rowspan=${topLeftCell.rowSpan}`);
        showToast(`已合并 ${mergeRows}×${mergeCols} 单元格`, 'success');
    }

    /**
     * 拆分当前选中的合并单元格
     * 将 colspan/rowspan > 1 的单元格还原为独立的小单元格
     */
    function unmergeCells() {
        // 获取当前选中的单元格
        let targetCell = null;

        if (selectedCells.length === 1) {
            targetCell = selectedCells[0];
        } else if (selectedCells.length === 0) {
            // 尝试从光标位置获取
            const selection = window.getSelection();
            if (selection.rangeCount) {
                const anchorNode = selection.anchorNode;
                targetCell = anchorNode.nodeType === Node.TEXT_NODE ?
                    anchorNode.parentElement.closest('td, th') :
                    anchorNode.closest('td, th');
            }
        } else {
            showToast('拆分时只能选中1个单元格', 'warning');
            return;
        }

        if (!targetCell) {
            showToast('请先选中一个已合并的单元格', 'warning');
            return;
        }

        const colspan = targetCell.colSpan || 1;
        const rowspan = targetCell.rowSpan || 1;

        if (colspan <= 1 && rowspan <= 1) {
            showToast('该单元格未合并，无需拆分', 'info');
            return;
        }

        const table = targetCell.closest('table');
        if (!table) return;

        historyManager.cancelPending();

        const parentRow = targetCell.parentElement;
        const cellTag = targetCell.tagName; // TH 或 TD
        const originalText = targetCell.textContent;
        const cellIndex = getCellIndex(targetCell);

        // 移除 colspan/rowspan 属性
        targetCell.removeAttribute('colspan');
        targetCell.removeAttribute('rowspan');

        // 在同一行右侧追加 (colspan - 1) 个新单元格
        for (let i = 1; i < colspan; i++) {
            const newCell = document.createElement(cellTag.toLowerCase());
            newCell.contentEditable = 'true';
            newCell.textContent = '';
            parentRow.insertBefore(newCell, targetCell.nextSibling);
        }

        // 如果 rowspan > 1，需要在下方每行对应位置也插入 (colspan) 个单元格
        if (rowspan > 1) {
            const allRows = Array.from(table.rows);
            const currentRowIndex = allRows.indexOf(parentRow);

            for (let r = 1; r < rowspan; r++) {
                const targetRow = allRows[currentRowIndex + r];
                if (!targetRow) break;

                // 计算插入位置（考虑前面单元格的colspan影响）
                const insertPos = findInsertPosition(targetRow, cellIndex);

                for (let c = 0; c < colspan; c++) {
                    const newCell = document.createElement(cellTag.toLowerCase());
                    newCell.contentEditable = 'true';
                    newCell.textContent = '';

                    if (insertPos + c < targetRow.cells.length) {
                        targetRow.insertBefore(newCell, targetRow.cells[insertPos + c]);
                    } else {
                        targetRow.appendChild(newCell);
                    }
                }
            }
        }

        // 刷新 resizer
        makeTableResizable(table);
        clearCellSelection();

        console.log(`[HTMLEditor] unmergeCells: 拆分 ${rowspan}×${colspan} → 独立单元格`);
        showToast(`已拆分为 ${rowspan}×${colspan} 个单元格`, 'success');
    }

    /**
     * 获取指定行列位置的单元格（考虑 colspan/rowspan 偏移）
     * @param {HTMLTableRowElement[]} rows - 表格所有行的数组
     * @param {number} rowIndex - 目标行号
     * @param {number} colIndex - 目标列号（逻辑列号）
     * @returns {HTMLTableCellElement|null}
     */
    function getCellAtPosition(rows, rowIndex, colIndex) {
        if (rowIndex < 0 || rowIndex >= rows.length) return null;
        const row = rows[rowIndex];
        if (!row) return null;

        let logicalCol = 0;
        for (let i = 0; i < row.cells.length; i++) {
            const cell = row.cells[i];
            if (logicalCol === colIndex) return cell;
            logicalCol += (cell.colSpan || 1);
            if (logicalCol > colIndex) return cell; // 当前单元格跨越了目标列
        }
        return null;
    }

    /**
     * 在指定行中找到逻辑列号对应的物理插入位置
     * @param {HTMLTableRowElement} row
     * @param {number} logicalCol - 逻辑列号
     * @returns {number} 物理插入索引（cells 数组中的位置）
     */
    function findInsertPosition(row, logicalCol) {
        let logicalColAcc = 0;
        for (let i = 0; i < row.cells.length; i++) {
            const cs = row.cells[i].colSpan || 1;
            if (logicalColAcc + cs > logicalCol) return i;
            logicalColAcc += cs;
        }
        return row.cells.length; // 追加到末尾
    }
    // ========== 合并/拆分单元格结束 ==========

    // 插入表格
    function insertTable() {
        // ★ 用临时ID精确标记新表格，避免querySelectorAll取到错误表格
        const tempId = '__new_table_' + Date.now();
        const tableHTML = `
            <table class="html-editable-table" id="${tempId}">
                <thead>
                    <tr>
                        <th contenteditable="true">列1</th>
                        <th contenteditable="true">列2</th>
                        <th contenteditable="true">列3</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td contenteditable="true">数据1</td>
                        <td contenteditable="true">数据2</td>
                        <td contenteditable="true">数据3</td>
                    </tr>
                    <tr>
                        <td contenteditable="true">数据4</td>
                        <td contenteditable="true">数据5</td>
                        <td contenteditable="true">数据6</td>
                    </tr>
                </tbody>
            </table>
            <p><br></p>
        `;

        insertHTML(tableHTML);

        // ★ 通过临时ID精确获取新插入的表格
        const newTable = document.getElementById(tempId);
        if (newTable) {
            newTable.removeAttribute('id'); // 移除临时ID
            makeTableResizable(newTable);
            setupTableCellEvents(newTable);
            console.log(`[HTMLEditor] insertTable: 新表格已初始化 (rows=${newTable.rows.length}, cols=${newTable.rows[0]?.cells.length || 0})`);
        } else {
            console.error('[HTMLEditor] insertTable: 未找到新插入的表格!');
        }

        showToast('已插入表格', 'success');
    }

    // 插入图片
    function insertImage() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = function() {
            const file = this.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    historyManager.cancelPending();
                    historyManager.save('插入图片', { force: true });
                    const imgHTML = `<img src="${e.target.result}" style="max-width:100%;margin:10px 0;"><p><br></p>`;
                    insertHTML(imgHTML);
                    historyManager.updateBaseline();
                    showToast('已插入图片', 'success');
                };
                reader.readAsDataURL(file);
            }
        };
        input.click();
    }

    // 插入形状
    function insertShape(type) {
        const shapeHTML = getShapeHTML(type);
        insertHTML(shapeHTML);
        showToast('已插入形状', 'success');
    }

    function getShapeHTML(type) {
        const colors = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6'];
        const color = colors[Math.floor(Math.random() * colors.length)];

        switch (type) {
            case 'rect':
                return `<div class="html-shape html-shape-rect" contenteditable="false" style="width:150px;height:100px;background:${color};margin:10px 0;"></div><p><br></p>`;
            case 'circle':
                return `<div class="html-shape html-shape-circle" contenteditable="false" style="width:100px;height:100px;background:${color};border-radius:50%;margin:10px 0;"></div><p><br></p>`;
            case 'arrow':
                return `<div class="html-shape html-shape-arrow" contenteditable="false" style="margin:10px 0;">
                    <svg width="150" height="50" viewBox="0 0 150 50">
                        <defs>
                            <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                                <polygon points="0 0, 10 3, 0 6" fill="${color}" />
                            </marker>
                        </defs>
                        <line x1="0" y1="25" x2="140" y2="25" stroke="${color}" stroke-width="3" marker-end="url(#arrowhead)"/>
                    </svg>
                </div><p><br></p>`;
            default:
                return '';
        }
    }

    // 连接线模式
    let connectorMode = false;
    let connectorStart = null;

    function activateConnectorMode() {
        connectorMode = !connectorMode;
        if (connectorMode) {
            document.body.classList.add('connector-mode');
            showToast('连接线模式：点击两个元素进行连接', 'info');
            document.getElementById('insertConnectorBtn').classList.add('active');
        } else {
            document.body.classList.remove('connector-mode');
            document.getElementById('insertConnectorBtn').classList.remove('active');
            connectorStart = null;
        }
    }

    // 插入HTML到光标位置
    function insertHTML(html) {
        const selection = window.getSelection();
        if (!selection.rangeCount) {
            // 如果没有选区，插入到文档末尾
            document.body.insertAdjacentHTML('beforeend', html);
            return;
        }

        const range = selection.getRangeAt(0);
        range.deleteContents();

        const fragment = range.createContextualFragment(html);
        const firstChild = fragment.firstChild;
        const lastChild = fragment.lastChild;
        range.insertNode(fragment);

        // 移动光标到插入内容之后
        range.setStartAfter(lastChild || firstChild || range.startContainer.lastChild);
        range.setEndAfter(lastChild || firstChild || range.startContainer.lastChild);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // 保存文档
    function saveDocument() {
        // 使用File System Access API
        if ('showSaveFilePicker' in window) {
            saveWithFileSystemAccessAPI();
        } else {
            // 回退到传统下载方式
            saveAsDownload();
        }
    }

    // 使用File System Access API保存
    async function saveWithFileSystemAccessAPI() {
        try {
            // 获取当前文件路径
            const currentPath = window.location.pathname;

            const handle = await window.showSaveFilePicker({
                suggestedName: currentPath.split('/').pop() || 'document.html',
                types: [{
                    description: 'HTML Document',
                    accept: {'text/html': ['.html', '.htm']}
                }],
                id: 'html-file' // 记住上次位置
            });

            const writable = await handle.createWritable();
            await writable.write(getCleanDocumentHTML());
            await writable.close();

            showToast('文档已保存！', 'success');
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('保存失败:', err);
                showToast('保存失败: ' + err.message, 'error');
            }
        }
    }

    // 传统下载方式
    function saveAsDownload() {
        const htmlContent = getCleanDocumentHTML();
        const blob = new Blob([htmlContent], {type: 'text/html'});
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'document-edited.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('文档已下载到下载文件夹', 'success');
    }

    // 显示提示消息
    function showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `html-editor-toast html-editor-toast-${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('show'), 10);

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // 通知popup状态变化
    function notifyStatusChange() {
        chrome.runtime.sendMessage({
            action: 'editorStatusChanged',
            isActive: isEditorActive
        }).catch(() => {
            // 忽略错误（popup可能已关闭）
        });
    }

    // 表格可调整大小功能
    function makeTableResizable(table) {
        // 如果已经有resizer，先移除
        removeTableResizer(table);

        table.classList.add('html-resizable-table');
        table.classList.add('html-table-resizable-initialized');

        // ★ 关键修复：使用 border-collapse: separate 避免单元格内部元素被表格整体裁剪
        // collapse 模式下表格是一个统一的盒模型，absolute 子元素超出 cell 边界时会被隐藏
        if (!table.dataset.originalBorderCollapse) {
            table.dataset.originalBorderCollapse = table.style.borderCollapse || 'collapse';
        }
        table.style.borderCollapse = 'separate';
        table.style.borderSpacing = '0px';

        // 创建列调整手柄 — 使用 fixed 定位，放到 body 上避免被 table 裁剪
        const firstRow = table.rows[0];
        if (firstRow) {
            Array.from(firstRow.cells).forEach((cell, colIndex) => {
                const resizer = document.createElement('div');
                resizer.className = 'html-table-resizer html-table-resizer-col';
                resizer.contentEditable = 'false';
                resizer.dataset.col = colIndex;
                resizer.dataset.type = 'col';
                resizer.dataset.tableId = table.dataset.tableId || (table.dataset.tableId = 'tbl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
                
                // ★ 放到 body 上而非 cell 内部
                document.body.appendChild(resizer);

                // ★ 定位到 cell 右边缘
                positionResizer(resizer, cell, 'col');

                // 绑定事件
                setupResizerEvents(resizer, table);
            });
        }

        // 创建行调整手柄 — 同样放到 body 上
        Array.from(table.rows).forEach((row, rowIndex) => {
            const firstCell = row.cells[0];
            if (firstCell) {
                const resizer = document.createElement('div');
                resizer.className = 'html-table-resizer html-table-resizer-row';
                resizer.contentEditable = 'false';
                resizer.dataset.row = rowIndex;
                resizer.dataset.type = 'row';
                resizer.dataset.tableId = table.dataset.tableId;
                
                document.body.appendChild(resizer);

                // ★ 定位到 cell 底边缘
                positionResizer(resizer, firstCell, 'row');

                // 绑定事件
                setupResizerEvents(resizer, table);
            }
        });

        // ★ 监听表格尺寸变化重新定位 resizer
        table._resizeObserver = table._resizeObserver || new ResizeObserver(() => updateResizerPositions(table));
        table._resizeObserver.observe(table);
        
        // ★ 监听滚动重新定位 resizer（fixed 定位需要跟随）
        if (!window._tableScrollHandler) {
            window._tableScrollHandler = true;
            window.addEventListener('scroll', function() {
                document.querySelectorAll('.html-table-resizable-initialized').forEach(function(t) {
                    if (t.dataset.tableId) updateResizerPositions(t);
                });
            }, { passive: true });
        }
    }

    // ★ 定位 resizer 到 cell 边缘
    function positionResizer(resizer, cell, type) {
        const rect = cell.getBoundingClientRect();
        if (type === 'col') {
            resizer.style.left = (rect.right - 7) + 'px';
            resizer.style.top = rect.top + 'px';
            resizer.style.height = rect.height + 'px';
        } else {
            resizer.style.left = rect.left + 'px';
            resizer.style.top = (rect.bottom - 7) + 'px';
            resizer.style.width = rect.width + 'px';
        }
    }

    // ★ 更新某个表格所有 resizer 的位置
    function updateResizerPositions(table) {
        const tableId = table.dataset.tableId;
        if (!tableId) return;
        
        document.querySelectorAll(`[data-table-id="${tableId}"].html-table-resizer-col`).forEach(r => {
            const colIndex = parseInt(r.dataset.col);
            const cell = table.rows[0]?.cells[colIndex];
            if (cell) positionResizer(r, cell, 'col');
        });
        
        document.querySelectorAll(`[data-table-id="${tableId}"].html-table-resizer-row`).forEach(r => {
            const rowIndex = parseInt(r.dataset.row);
            const cell = table.rows[rowIndex]?.cells[0];
            if (cell) positionResizer(r, cell, 'row');
        });
    }

    function removeTableResizer(table) {
        table.classList.remove('html-resizable-table');
        table.classList.remove('html-table-resizable-initialized');
        // ★ 清理 body 上的 resizer（通过 data-table-id 关联）
        const tableId = table.dataset.tableId;
        if (tableId) {
            document.querySelectorAll(`[data-table-id="${tableId}"].html-table-resizer`).forEach(el => el.remove());
        }
        // 清理 ResizeObserver
        if (table._resizeObserver) {
            table._resizeObserver.disconnect();
            table._resizeObserver = null;
        }
        // 恢复原始 border-collapse
        if (table.dataset.originalBorderCollapse) {
            table.style.borderCollapse = table.dataset.originalBorderCollapse;
        }
    }

    // 设置调整手柄事件
    function setupResizerEvents(resizer, table) {
        var dragState = null;
        var boundMouseMove = null;
        var boundMouseUp = null;

        resizer.addEventListener('mousedown', onMousedown, true);

        function onMousedown(e) {
            console.log('[HTMLEditor] Resizer mousedown!', e.target.className, 'type:', resizer.dataset.type);
            e.preventDefault();
            e.stopPropagation();

            var type = resizer.dataset.type;
            var index = parseInt(resizer.dataset[type]);

            try {
                historyManager.cancelPending();
                historyManager.save(type === 'col' ? '调整列宽' : '调整行高', { force: true });
            } catch (err) {
                console.error('[HTMLEditor] save failed:', err);
            }

            dragState = { type: type, index: index, startX: e.clientX, startY: e.clientY, table: table };

            resizer.classList.add('active');
            document.body.style.cursor = type === 'col' ? 'col-resize' : 'row-resize';
            document.body.style.userSelect = 'none';

            boundMouseMove = onMouseMove.bind(null, dragState);
            boundMouseUp = onMouseUp.bind(null, dragState, resizer);
            document.addEventListener('mousemove', boundMouseMove);
            document.addEventListener('mouseup', boundMouseUp);
        }

        function onMouseMove(state, e) {
            if (state.type === 'col') {
                var cell = state.table.rows[0].cells[state.index];
                if (cell) {
                    var newWidth = Math.max(50, cell.offsetWidth + e.clientX - state.startX);
                    Array.from(state.table.rows).forEach(function(row) {
                        if (row.cells[state.index]) {
                            row.cells[state.index].style.width = newWidth + 'px';
                            row.cells[state.index].style.minWidth = newWidth + 'px';
                        }
                    });
                    state.startX = e.clientX;
                }
            } else {
                var row = state.table.rows[state.index];
                if (row) {
                    var newHeight = Math.max(30, row.offsetHeight + e.clientY - state.startY);
                    row.style.height = newHeight + 'px';
                    row.style.minHeight = newHeight + 'px';
                    state.startY = e.clientY;
                }
            }
            // ★ 拖拽时同步更新所有 resizer 位置
            updateResizerPositions(state.table);
        }

        function onMouseUp(state, r, e) {
            r.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', boundMouseMove);
            document.removeEventListener('mouseup', boundMouseUp);
            historyManager.updateBaseline();
            dragState = null; boundMouseMove = null; boundMouseUp = null;
        }
    }

    // ========== 字体大小调整（DOM 方式，替代 execCommand fontSize） ==========

    /**
     * 字号值（HTML font size 1-7）到 CSS 像素值的映射
     * 替代不可靠的 execCommand('fontSize')，直接操作 DOM + CSS style
     */
    const FONT_SIZE_MAP = {
        '1': '10px',   // 特小
        '2': '13px',   // 小
        '3': '16px',   // 正常
        '4': '18px',   // 较大
        '5': '24px',   // 大
        '6': '32px',   // 很大
        '7': '48px'    // 超大
    };

    /**
     * 应用字体大小 — 支持普通文本选区、表格单元格内选区、多单元格选中
     *
     * ★ 核心问题：execCommand('fontSize') 在 contenteditable 表格单元格中行为不一致，
     *   经常出现部分生效或不生效的情况。改用直接 DOM 操作：
     *   - 有文本选区 → 用 Range.surroundContents 包裹 <span style="font-size:...">
     *   - 光标在单元格内（无选区）→ 给整个单元格内容包裹 <span>
     *   - 多个单元格被 selectedCells 选中 → 批量处理每个单元格
     */
    function applyFontSize(sizeValue) {
        const cssSize = FONT_SIZE_MAP[sizeValue] || '16px';

        // 情况1：有多个表格单元格被多选（Ctrl+点击 / 拖拽）
        if (selectedCells.length >= 2) {
            selectedCells.forEach(cell => wrapCellContentWithFontSize(cell, cssSize));
            showToast(`已设置 ${selectedCells.length} 个单元格字体`, 'success');
            return;
        }

        const selection = window.getSelection();
        if (!selection.rangeCount) return;

        const range = selection.getRangeAt(0);

        // 判断光标是否在表格单元格内
        const anchorNode = selection.anchorNode;
        const cell = anchorNode.nodeType === Node.TEXT_NODE ?
            anchorNode.parentElement.closest('td, th') :
            anchorNode.closest('td, th');

        if (cell) {
            // 情况2：在表格单元格中
            if (range.collapsed) {
                // 2a：光标折叠（无文字选中）→ 包裹整个单元格内容
                wrapCellContentWithFontSize(cell, cssSize);
            } else {
                // 2b：有文字选中 → 只包裹选中的部分
                wrapRangeWithStyle(range, cssSize);
            }
        } else {
            // 情况3：在普通文本区域（非表格）
            if (range.collapsed) {
                // 无选中 → 在光标位置插入一个带样式的标记，后续输入继承样式
                applyFontSizeAtCursor(range, cssSize);
            } else {
                wrapRangeWithStyle(range, cssSize);
            }
        }
    }

    /**
     * 将整个单元格的内容用 <span style="font-size:..."> 包裹
     * 处理已存在的嵌套 span，避免无限嵌套
     */
    function wrapCellContentWithFontSize(cell, cssSize) {
        // 先清除该单元格上之前可能存在的字体大小标记（避免叠加冲突）
        clearFontSizeSpans(cell);

        const content = cell.innerHTML;
        if (!content.trim() || content === '<br>') {
            // 空单元格 — 直接给 cell 设 style，后续输入继承
            cell.style.fontSize = cssSize;
        } else {
            // 有内容 — 包裹在 span 中
            const span = document.createElement('span');
            span.style.fontSize = cssSize;
            span.innerHTML = content;
            cell.innerHTML = '';
            cell.appendChild(span);
            // 确保 span 可编辑
            span.contentEditable = 'true';
        }
    }

    /**
     * 用 <span style="font-size:..."> 包裹 Range 选中的内容
     * 使用 surroundContents 的安全版本（避免跨元素边界报错）
     */
    function wrapRangeWithStyle(range, cssSize) {
        try {
            const span = document.createElement('span');
            span.style.fontSize = cssSize;

            // ★ 安全包裹：检查 range 是否跨多个元素边界
            const startContainer = range.startContainer;
            const endContainer = range.endContainer;

            if (startContainer === endContainer || (
                startContainer.nodeType === Node.TEXT_NODE && endContainer.nodeType === Node.TEXT_NODE &&
                startContainer.parentElement === endContainer.parentElement
            )) {
                // 简单情况：同一容器内，可直接 surroundContents
                range.surroundContents(span);
            } else {
                // 复杂情况：跨元素边界，用 extractContents + appendChild
                const fragment = range.extractContents();
                span.appendChild(fragment);
                range.insertNode(span);

                // 清理空文本节点和合并相邻的同类 span
                cleanupAfterWrap(span);
            }
        } catch (e) {
            console.warn('[HTMLEditor] wrapRangeWithStyle 失败:', e.message);
            // 降级：尝试用 execCommand 兜底
            document.execCommand('fontSize', false, '7');
        }
    }

    /**
     * 在折叠的光标位置应用字体大小（用于非表格区域的纯光标状态）
     * 插入一个零宽度的样式携带者
     */
    function applyFontSizeAtCursor(range, cssSize) {
        const span = document.createElement('span');
        span.style.fontSize = cssSize;
        span.innerHTML = '\u200B'; // 零宽空格作为占位
        range.insertNode(span);

        // 将光标移到 span 之后
        range.setStartAfter(span);
        range.setEndAfter(span);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    /**
     * 清除单元格内之前的字体大小 span 标记
     * 避免 <span style="font-size:16px"><span style="font-size:24px">text</span></span> 无限嵌套
     */
    function clearFontSizeSpans(cell) {
        // 找到所有直接子级且只包含 font-size style 的 span
        Array.from(cell.children).forEach(child => {
            if (child.tagName === 'SPAN' && child.style.fontSize) {
                // 将其内容提升到父级
                const parent = child.parentElement;
                while (child.firstChild) {
                    parent.insertBefore(child.firstChild, child);
                }
                child.remove();
            }
        });
        // 同时清除 cell 本身的 fontSize（如果之前设过）
        cell.style.fontSize = '';
    }

    /**
     * 包裹后的清理：合并相邻的相同字号 span，移除空的文本节点
     */
    function cleanupAfterWrap(wrapSpan) {
        // 如果 wrapSpan 为空或只有空白，移除它
        if (!wrapSpan.textContent.trim()) {
            const parent = wrapSpan.parentElement;
            if (parent) {
                while (wrapSpan.firstChild) parent.insertBefore(wrapSpan.firstChild, wrapSpan);
                wrapSpan.remove();
            }
        }
    }
    // ========== 字体大小调整结束 ==========

    // 设置表格单元格背景色（支持多选）
    function setTableCellBackground(color) {
        // 如果有多选单元格，批量设置
        if (selectedCells.length > 0) {
            selectedCells.forEach(cell => {
                cell.style.backgroundColor = color;
            });
            showToast(`已设置 ${selectedCells.length} 个单元格背景色`, 'success');
            return;
        }

        // 单个单元格设置
        const selection = window.getSelection();
        if (!selection.rangeCount) {
            showToast('请先点击表格单元格', 'warning');
            return;
        }

        const anchorNode = selection.anchorNode;
        const cell = anchorNode.nodeType === 3 ?
            anchorNode.parentElement.closest('td, th') :
            anchorNode.closest('td, th');

        if (!cell) {
            showToast('请先点击表格单元格', 'warning');
            return;
        }

        // 设置选中单元格的背景色
        cell.style.backgroundColor = color;
        showToast('已设置单元格背景色', 'success');
    }

    // 设置表格单元格事件
    function setupTableCellEvents(table) {
        if (!table) return;

        // 确保所有单元格都可编辑
        table.querySelectorAll('td, th').forEach(cell => {
            if (!cell.hasAttribute('contenteditable')) {
                cell.contentEditable = 'true';
            }
        });

        // 添加单元格选中样式
        table.addEventListener('click', function(e) {
            // 跳过表格调整手柄的点击
            if (e.target.closest('.html-table-resizer')) return;

            const cell = e.target.closest('td, th');
            if (!cell) return;

            // 移除其他单元格的选中状态
            table.querySelectorAll('td, th').forEach(c => c.classList.remove('cell-selected'));

            // 添加当前单元格选中状态
            cell.classList.add('cell-selected');
        });
    }

    // ========== 表格智能粘贴（Excel/外部表格数据展开粘贴） ==========

    /**
     * 设置全局 paste 事件监听，处理在表格单元格内粘贴 Excel/表格数据的情况
     *
     * 问题：从 Excel 复制表格数据后 Ctrl+V 到 td 内，
     *       浏览器默认会将整个 <table> 嵌套插入到单元格中 → 表格套表格
     * 解决：拦截 paste 事件，检测粘贴内容是否为表格，如果是则将数据展开填入当前表格
     */
    function setupSmartTablePaste() {
        document.addEventListener('paste', function(e) {
            if (!isEditorActive) return;

            // 获取光标所在的单元格
            const selection = window.getSelection();
            if (!selection.rangeCount) return;

            const anchorNode = selection.anchorNode;
            const cell = anchorNode.nodeType === Node.TEXT_NODE ?
                anchorNode.parentElement.closest('td, th') :
                anchorNode.closest('td, th');

            // 不在表格单元格内 → 不干预，走默认粘贴
            if (!cell) return;

            const table = cell.closest('table');
            if (!table) return;

            // ★ 获取剪贴板内容（HTML 格式）
            const clipboardData = e.clipboardData;
            if (!clipboardData) return;

            const htmlText = clipboardData.getData('text/html');
            if (!htmlText || !htmlText.includes('<table')) {
                // 粘贴的不是表格内容 → 不干预
                return;
            }

            // ★ 粘贴的是表格数据 → 拦截默认行为，执行展开粘贴
            e.preventDefault();
            e.stopPropagation();

            console.log('[HTMLEditor] 📋 SmartTablePaste: 检测到表格内粘贴表格数据，执行展开粘贴');

            historyManager.cancelPending();
            historyManager.save('表格粘贴', { force: true });

            try {
                expandPasteTable(table, cell, htmlText);
                historyManager.updateBaseline();
                showToast('已将表格数据展开粘贴到当前表格', 'success');
            } catch (err) {
                console.error('[HTMLEditor] SmartTablePaste 失败:', err);
                showToast('粘贴失败: ' + err.message, 'error');
            }
        }, true); // 使用捕获阶段优先于 contenteditable 的默认处理
    }

    /**
     * 将粘贴的表格 HTML 数据展开填充到目标表格中
     * @param {HTMLTableElement} targetTable - 当前编辑的表格
     * @param {HTMLTableCellElement} startCell - 粘贴起始单元格
     * @param {string} pastedHTML - 剪贴板中的 HTML 内容（包含 table）
     */
    function expandPasteTable(targetTable, startCell, pastedHTML) {
        // 1. 解析粘贴的 HTML，提取其中的表格数据
        const parser = new DOMParser();
        const doc = parser.parseFromString(pastedHTML, 'text/html');
        const sourceTable = doc.querySelector('table');

        if (!sourceTable) {
            console.warn('[HTMLEditor] expandPasteTable: 粘贴HTML中未找到table元素');
            // 降级：作为纯文本粘贴
            const plainText = doc.body.textContent || '';
            startCell.textContent = plainText;
            return;
        }

        // 2. 将源表格转为二维数组 [row][col] = textContent
        const sourceRows = Array.from(sourceTable.rows);
        const sourceData = sourceRows.map(row => Array.from(row.cells).map(cell => cell.textContent.trim()));

        if (sourceData.length === 0) return;

        // 3. 获取起始位置
        const targetRows = Array.from(targetTable.rows);
        const startRowIndex = targetRows.indexOf(startCell.closest('tr'));
        const startColIndex = Array.from(startCell.parentElement.cells).indexOf(startCell);

        console.log(`[HTMLEditor] expandPasteTable: 源=${sourceData.length}行×${(sourceData[0]||[]).length}列, 起点=(${startRowIndex},${startColIndex}), 目标表格当前=${targetRows.length}行×${targetRows[0]?.cells.length||0}列`);

        // 4. 确保目标表格有足够的行列
        ensureTableSize(targetTable, startRowIndex + sourceData.length, startColIndex + (sourceData[0] || []).length);

        // 5. 重新获取行引用（ensureTableSize 可能改变了DOM）
        const finalRows = Array.from(targetTable.rows);

        // 6. 填充数据
        for (let r = 0; r < sourceData.length; r++) {
            const rowData = sourceData[r];
            const targetRow = finalRows[startRowIndex + r];
            if (!targetRow) continue;

            for (let c = 0; c < rowData.length; c++) {
                const targetCell = targetRow.cells[startColIndex + c];
                if (targetCell) {
                    // 保留单元格的可编辑属性，只替换内容
                    targetCell.textContent = rowData[c];
                    if (!targetCell.hasAttribute('contenteditable')) {
                        targetCell.contentEditable = 'true';
                    }
                }
            }
        }

        // 7. 刷新 resizer 位置
        updateResizerPositions(targetTable);

        console.log(`[HTMLEditor] expandPasteTable: 完成! 填入了 ${sourceData.length}行×${(sourceData[0]||[]).length}列`);
    }

    /**
     * 确保表格至少有 minRows 行和 minCols 列，不足则扩展
     * @param {HTMLTableElement} table
     * @param {number} minRows - 最少需要的行数
     * @param {number} minCols - 最少需要的列数
     */
    function ensureTableSize(table, minRows, minCols) {
        const rows = Array.from(table.rows);
        const currentRows = rows.length;
        const currentCols = rows[0] ? rows[0].cells.length : 0;

        // 扩展列
        if (minCols > currentCols) {
            const colsToAdd = minCols - currentCols;
            rows.forEach(row => {
                for (let i = 0; i < colsToAdd; i++) {
                    const newCell = row.cells[0].tagName === 'TH' ?
                        document.createElement('th') : document.createElement('td');
                    newCell.contentEditable = 'true';
                    newCell.textContent = '';
                    row.appendChild(newCell);
                }
            });
            console.log(`[HTMLEditor] ensureTableSize: 扩展了 ${colsToAdd} 列 (${currentCols}→${minCols})`);
        }

        // 扩展行
        if (minRows > currentRows) {
            const rowsToAdd = minRows - currentRows;
            // 参考最后一行的结构来创建新行
            const refRow = rows[currentRows - 1];
            if (refRow) {
                for (let i = 0; i < rowsToAdd; i++) {
                    const newRow = document.createElement('tr');
                    const targetColCount = Math.max(minCols, currentCols);
                    for (let c = 0; c < targetColCount; c++) {
                        const newCell = document.createElement('td');
                        newCell.contentEditable = 'true';
                        newCell.textContent = '';
                        newRow.appendChild(newCell);
                    }
                    // 插入到 tbody 中
                    const tbody = table.querySelector('tbody') || table;
                    tbody.appendChild(newRow);
                }
            }
            console.log(`[HTMLEditor] ensureTableSize: 扩展了 ${rowsToAdd} 行 (${currentRows}→${minRows})`);
        }
    }
    // ========== 表格智能粘贴结束 ==========

    // RGB颜色转HEX
    function rgbToHex(rgb) {
        if (!rgb) return '#ffffff';

        // 如果已经是hex格式
        if (rgb.startsWith('#')) return rgb;

        // 解析rgb(r, g, b)格式
        const match = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (!match) return '#ffffff';

        const r = parseInt(match[1]);
        const g = parseInt(match[2]);
        const b = parseInt(match[3]);

        return '#' + [r, g, b].map(x => {
            const hex = x.toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }

    // 初始化完成提示
    console.log('[HTMLEditor] ✅ 注入完成，消息监听器已就绪');
})();
