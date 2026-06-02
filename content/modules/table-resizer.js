// content/modules/table-resizer.js - 表格调整大小模块

(function() {
    'use strict';

    // 防止重复加载
    if (window.__TableResizerLoaded__) {
        return;
    }
    window.__TableResizerLoaded__ = true;

    class TableResizer {
        constructor(table) {
            this.table = table;
            this.active = false;
            this.dragState = null;
            this.resizers = [];
            this.init();
        }

        init() {
            // 添加resizer类
            this.table.classList.add('html-resizable-table');

            // 创建列调整手柄
            this.createColumnResizers();

            // 创建行调整手柄
            this.createRowResizers();

            // 绑定事件
            this.bindEvents();
        }

        createColumnResizers() {
            const firstRow = this.table.rows[0];
            if (!firstRow) return;

            Array.from(firstRow.cells).forEach((cell, index) => {
                const resizer = document.createElement('div');
                resizer.className = 'html-table-resizer html-table-resizer-col';
                resizer.contentEditable = 'false';
                resizer.dataset.col = index;
                resizer.dataset.type = 'col';
                cell.style.position = 'relative';
                cell.appendChild(resizer);
                this.resizers.push(resizer);
            });
        }

        createRowResizers() {
            Array.from(this.table.rows).forEach((row, index) => {
                const firstCell = row.cells[0];
                if (!firstCell) return;

                const resizer = document.createElement('div');
                resizer.className = 'html-table-resizer html-table-resizer-row';
                resizer.contentEditable = 'false';
                resizer.dataset.row = index;
                resizer.dataset.type = 'row';
                firstCell.style.position = 'relative';
                firstCell.appendChild(resizer);
                this.resizers.push(resizer);
            });
        }

        bindEvents() {
            this.resizers.forEach(resizer => {
                resizer.addEventListener('mousedown', this.handleMouseDown.bind(this));
            });
        }

        handleMouseDown(e) {
            e.preventDefault();
            e.stopPropagation();

            const resizer = e.target;
            const type = resizer.dataset.type;
            const index = parseInt(resizer.dataset[type]);

            // 记录拖拽状态
            this.dragState = {
                type: type,
                index: index,
                startX: e.clientX,
                startY: e.clientY,
                resizer: resizer
            };

            // 添加拖拽样式
            resizer.classList.add('active');
            document.body.style.cursor = type === 'col' ? 'col-resize' : 'row-resize';
            document.body.style.userSelect = 'none';

            // 绑定全局事件
            this.boundMouseMove = this.handleMouseMove.bind(this);
            this.boundMouseUp = this.handleMouseUp.bind(this);
            document.addEventListener('mousemove', this.boundMouseMove);
            document.addEventListener('mouseup', this.boundMouseUp);
        }

        handleMouseMove(e) {
            if (!this.dragState) return;

            const { type, index, startX, startY } = this.dragState;

            if (type === 'col') {
                // 调整列宽
                const deltaX = e.clientX - startX;
                const col = this.getColumn(index);
                if (col) {
                    const currentWidth = col.offsetWidth;
                    const newWidth = Math.max(50, currentWidth + deltaX);
                    this.setColumnWidth(index, newWidth);
                    this.dragState.startX = e.clientX;
                }
            } else {
                // 调整行高
                const deltaY = e.clientY - startY;
                const row = this.table.rows[index];
                if (row) {
                    const currentHeight = row.offsetHeight;
                    const newHeight = Math.max(30, currentHeight + deltaY);
                    this.setRowHeight(index, newHeight);
                    this.dragState.startY = e.clientY;
                }
            }
        }

        handleMouseUp(e) {
            if (!this.dragState) return;

            // 移除拖拽样式
            this.dragState.resizer.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            // 清除拖拽状态
            this.dragState = null;

            // 解绑全局事件
            document.removeEventListener('mousemove', this.boundMouseMove);
            document.removeEventListener('mouseup', this.boundMouseUp);
        }

        getColumn(index) {
            const firstRow = this.table.rows[0];
            return firstRow ? firstRow.cells[index] : null;
        }

        setColumnWidth(index, width) {
            Array.from(this.table.rows).forEach(row => {
                if (row.cells[index]) {
                    row.cells[index].style.width = width + 'px';
                    row.cells[index].style.minWidth = width + 'px';
                    row.cells[index].style.maxWidth = width + 'px';
                }
            });
        }

        setRowHeight(index, height) {
            const row = this.table.rows[index];
            if (row) {
                row.style.height = height + 'px';
                row.style.minHeight = height + 'px';
            }
        }

        destroy() {
            // 清理resizer元素
            this.resizers.forEach(resizer => resizer.remove());
            this.resizers = [];

            // 移除类
            this.table.classList.remove('html-resizable-table');

            // 重置样式
            Array.from(this.table.rows).forEach(row => {
                Array.from(row.cells).forEach(cell => {
                    cell.style.position = '';
                    cell.style.width = '';
                    cell.style.minWidth = '';
                    cell.style.maxWidth = '';
                });
                row.style.height = '';
                row.style.minHeight = '';
            });
        }
    }

    // 导出
    window.__TableResizer = TableResizer;

    // 注意：表格 resizer 的初始化由 injector.js 的 makeTableResizable() 统一管理，
    // 此处不再自动初始化，避免与 injector.js 的 resizer 系统冲突。

    console.log('Table Resizer module loaded');
})();
