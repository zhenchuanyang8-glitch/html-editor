// popup.js - Chrome扩展弹窗逻辑

document.addEventListener('DOMContentLoaded', function() {
    const toggleEditorBtn = document.getElementById('toggleEditorBtn');
    const toggleBtnText = document.getElementById('toggleBtnText');
    const saveBtn = document.getElementById('saveBtn');
    const pageStatusIcon = document.getElementById('pageStatusIcon');
    const pageStatusText = document.getElementById('pageStatusText');
    const editorStatusIcon = document.getElementById('editorStatusIcon');
    const editorStatusText = document.getElementById('editorStatusText');
    const mainContent = document.getElementById('mainContent');
    const notSupported = document.getElementById('notSupported');

    // 检查当前标签页
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        const url = currentTab.url;

        // 检查是否是本地HTML文件
        if (!url.startsWith('file://') || !url.match(/\.(html?|htm)$/i)) {
            mainContent.style.display = 'none';
            notSupported.style.display = 'block';
            return;
        }

        // 是本地HTML文件，更新状态
        pageStatusIcon.className = 'status-icon active';
        pageStatusIcon.textContent = '✓';
        pageStatusText.textContent = '本地HTML文档';

        // 检查编辑器是否已注入
        checkEditorStatus(currentTab.id);
    });

    // 检查编辑器状态（带自动注入兜底）
    function checkEditorStatus(tabId) {
        chrome.tabs.sendMessage(tabId, {action: 'checkStatus'}, function(response) {
            if (chrome.runtime.lastError) {
                console.log('Content script 未就绪，尝试注入...', chrome.runtime.lastError.message);
                // 尝试注入 content script
                chrome.scripting.executeScript({
                    target: {tabId: tabId},
                    files: ['content/injector.js']
                }, () => {
                    if (!chrome.runtime.lastError) {
                        setTimeout(() => checkEditorStatus(tabId), 200);
                    } else {
                        // 注入也失败，显示未启动
                        editorStatusIcon.className = 'status-icon inactive';
                        editorStatusIcon.textContent = '○';
                        editorStatusText.textContent = '编辑器未启动';
                        toggleBtnText.textContent = '启动编辑器';
                        saveBtn.disabled = true;
                    }
                });
                return;
            }
            if (response && response.isEditorActive) {
                // 编辑器已启动
                editorStatusIcon.className = 'status-icon active';
                editorStatusIcon.textContent = '✓';
                editorStatusText.textContent = '编辑器运行中';
                toggleBtnText.textContent = '关闭编辑器';
                saveBtn.disabled = false;
            } else {
                // 编辑器已注入但未启动
                editorStatusIcon.className = 'status-icon inactive';
                editorStatusIcon.textContent = '○';
                editorStatusText.textContent = '编辑器就绪';
                toggleBtnText.textContent = '启动编辑器';
                saveBtn.disabled = true;
            }
        });
    }

    // 切换编辑器（带自动注入重试）
    toggleEditorBtn.addEventListener('click', function() {
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            const tabId = tabs[0].id;

            // 先尝试发送消息
            chrome.tabs.sendMessage(tabId, {action: 'toggleEditor'}, function(response) {
                if (chrome.runtime.lastError) {
                    console.warn('Content script 未响应，尝试注入...', chrome.runtime.lastError.message);
                    // 兜底：使用 scripting API 注入 content script
                    chrome.scripting.executeScript({
                        target: {tabId: tabId},
                        files: ['content/injector.js']
                    }, () => {
                        if (chrome.runtime.lastError) {
                            console.error('注入也失败:', chrome.runtime.lastError);
                            alert('无法启动编辑器。请按 F5 刷新页面后重试。');
                            return;
                        }
                        console.log('Content script 已注入，等待 300ms 后重试...');
                        // 等待脚本初始化完成后重新发消息
                        setTimeout(() => {
                            chrome.tabs.sendMessage(tabId, {action: 'toggleEditor'}, function(retryResponse) {
                                if (chrome.runtime.lastError) {
                                    alert('编辑器启动失败。请检查页面 Console 是否有错误。');
                                    return;
                                }
                                checkEditorStatus(tabId);
                            });
                        }, 300);
                    });
                    return;
                }
                if (response) {
                    checkEditorStatus(tabId);
                }
            });
        });
    });

    // 保存文档
    saveBtn.addEventListener('click', function() {
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            const tabId = tabs[0].id;

            chrome.tabs.sendMessage(tabId, {action: 'saveDocument'}, function(response) {
                if (response && response.success) {
                    saveBtn.textContent = '已保存';
                    setTimeout(() => {
                        saveBtn.textContent = '保存文档';
                    }, 2000);
                }
            });
        });
    });

    // 监听来自content script的消息
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (request.action === 'editorStatusChanged') {
            chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
                if (sender.tab.id === tabs[0].id) {
                    checkEditorStatus(tabs[0].id);
                }
            });
        }
    });
});
