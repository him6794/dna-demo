'use strict';

// The model owns connectivity; DOM nodes never serve as the source of truth.
class NucleotideSimulator {
    static STORAGE_KEY = 'nucleotide-simulator-v1';
    static HISTORY_LIMIT = 100;

    constructor() {
        this.workCanvas = document.getElementById('work-canvas');
        this.model = new NucleotideModel();
        this.selectedId = null;
        this.rotationMode = false;
        this.interaction = null;
        this.undoStack = [];
        this.redoStack = [];
        this.componentElements = new Map();
        this.connectionElements = new Map();
        this.palette = [...document.querySelectorAll('.components-panel .component')];
        this.suppressClick = false;
        this.setupEvents();
        this.restore();
        this.render();
    }

    get components() { return this.model.components; }
    get connections() { return this.model.connections; }
    get selectedComponent() { return this.components.find(c => c.id === this.selectedId); }

    setupEvents() {
        this.palette.forEach(button => {
            button.addEventListener('click', () => this.addComponent(button));
            button.addEventListener('dragstart', event => {
                event.dataTransfer.setData('application/x-nucleotide', String(this.palette.indexOf(button)));
                event.dataTransfer.setData('text/plain', button.getAttribute('aria-label'));
                event.dataTransfer.effectAllowed = 'copy';
                this.draggedPalette = button;
            });
            button.addEventListener('dragend', () => {
                this.draggedPalette = null;
                this.workCanvas.classList.remove('drag-over');
            });
        });
        this.workCanvas.addEventListener('dragover', event => {
            if (!this.draggedPalette) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            this.workCanvas.classList.add('drag-over');
        });
        this.workCanvas.addEventListener('dragleave', event => {
            if (!this.workCanvas.contains(event.relatedTarget)) this.workCanvas.classList.remove('drag-over');
        });
        this.workCanvas.addEventListener('drop', event => {
            event.preventDefault();
            this.workCanvas.classList.remove('drag-over');
            if (this.draggedPalette) this.addComponent(this.draggedPalette, this.canvasPoint(event));
            this.draggedPalette = null;
        });
        this.workCanvas.addEventListener('click', event => {
            if (this.suppressClick && event.detail > 0) { this.suppressClick = false; return; }
            const component = event.target.closest('.canvas-component');
            const bond = event.target.closest('[data-connection-id]');
            if (component) this.selectOrConnect(component.id);
            else if (bond) this.change(() => this.model.disconnect(bond.dataset.connectionId), '已移除連線');
            else this.select(null);
        });
        this.workCanvas.addEventListener('contextmenu', event => {
            const component = event.target.closest('.canvas-component');
            if (!component) return;
            event.preventDefault();
            const stop = this.rotationMode && this.selectedId === component.id;
            this.select(component.id);
            this.rotationMode = !stop;
            this.renderSelection();
            this.showMessage(stop ? '已結束旋轉' : '在畫布拖動以旋轉整組；Shift 精細調整，Escape 結束');
        });
        this.workCanvas.addEventListener('pointerdown', event => this.startPointer(event));
        this.workCanvas.addEventListener('pointermove', event => this.movePointer(event));
        this.workCanvas.addEventListener('pointerup', event => this.endPointer(event));
        this.workCanvas.addEventListener('pointercancel', () => this.cancelPointer());
        this.workCanvas.addEventListener('lostpointercapture', () => {
            if (this.interaction) this.cancelPointer();
        });
        document.addEventListener('keydown', event => this.handleKey(event));
        document.addEventListener('pointerup', event => {
            if (this.cancelledPointerId !== event.pointerId) return;
            this.cancelledPointerId = null;
            setTimeout(() => { this.suppressClick = false; }, 0);
        });
        document.addEventListener('click', event => {
            if (!event.target.closest('.canvas-component, #work-canvas, #selected-toolbar')) this.select(null);
        });
        window.addEventListener('blur', () => this.cancelPointer());

        const on = (id, action) => document.getElementById(id).addEventListener('click', action);
        on('undo', () => this.undo());
        on('redo', () => this.redo());
        on('clear-all', () => this.change(() => { this.model.clear(); this.select(null); }, '已清除畫布，可復原'));
        on('rotate-left', () => this.rotateSelected(-15));
        on('rotate-right', () => this.rotateSelected(15));
        on('disconnect-selected', () => {
            if (this.selectedId) this.change(() => this.model.disconnectComponent(this.selectedId), '已移除此組件的連線');
        });
        on('delete-selected', () => this.deleteSelected());
        on('load-dna-example', () => this.loadExample('DNA'));
        on('load-rna-example', () => this.loadExample('RNA'));
        on('export-project', () => this.exportProject());
        on('import-project', () => document.getElementById('import-file').click());
        document.getElementById('import-file').addEventListener('change', event => this.importProject(event));
    }

    canvasPoint(event) {
        const rect = this.workCanvas.getBoundingClientRect();
        return { x: event.clientX - rect.left - this.workCanvas.clientLeft,
            y: event.clientY - rect.top - this.workCanvas.clientTop };
    }

    addComponent(button, point) {
        const viewport = document.getElementById('canvas-viewport');
        if (!point) {
            // Fill visible free cells so palette clicks do not stack every piece.
            const left = viewport.scrollLeft + 24;
            const top = viewport.scrollTop + 56;
            let position;
            for (let y = top; y < top + viewport.clientHeight - 70 && !position; y += 85) {
                for (let x = left; x < left + viewport.clientWidth - 70; x += 85) {
                    if (!this.components.some(c => Math.abs(c.x - x) < 65 && Math.abs(c.y - y) < 65)) {
                        position = { x: x + 30, y: y + 30 };
                        break;
                    }
                }
            }
            point = position || { x: left + 30, y: top + 30 };
        }
        this.change(() => this.model.addComponent({
            type: button.dataset.type, base: button.dataset.base, sugarType: button.dataset.sugarType,
            x: Math.max(0, Math.min(point.x - 30, this.workCanvas.clientWidth - 60, NucleotideModel.MAX_COORDINATE)),
            y: Math.max(0, Math.min(point.y - 30, this.workCanvas.clientHeight - 60, NucleotideModel.MAX_COORDINATE)), rotation: 0
        }), '已加入組件；選擇兩個組件即可連線');
    }

    select(id) {
        this.selectedId = id;
        this.rotationMode = false;
        this.renderSelection();
    }

    selectOrConnect(id) {
        if (this.rotationMode) { this.select(id); return; }
        if (this.selectedId === id) { this.select(null); return; }
        if (!this.selectedId) {
            this.select(id);
            this.showMessage('已選取組件；點選另一組件連線，或使用下方工具');
            return;
        }
        const from = this.selectedId;
        this.select(null);
        this.change(() => this.model.connect(from, id), '已建立連線');
    }

    snapshot() { return JSON.stringify(this.model.toJSON()); }

    remember(before) {
        // Pointer and keyboard movement edit coordinates directly. Validate them
        // before they can enter history or persistent storage.
        NucleotideModel.fromJSON(this.model.toJSON());
        if (before === this.snapshot()) return false;
        this.undoStack.push(before);
        if (this.undoStack.length > NucleotideSimulator.HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack = [];
        this.persist();
        return true;
    }

    change(action, message) {
        this.cancelPointer();
        const before = this.snapshot();
        try {
            action();
            this.remember(before);
            this.render();
            if (message) this.showMessage(message, 'success');
        } catch (error) {
            // Failed operations are atomic, including multi-step examples/imports.
            this.model = NucleotideModel.fromJSON(JSON.parse(before));
            this.render();
            this.showMessage(error.message, 'error');
        }
    }

    undo() { this.travelHistory(this.undoStack, this.redoStack, '已復原'); }
    redo() { this.travelHistory(this.redoStack, this.undoStack, '已重做'); }

    travelHistory(source, target, message) {
        this.cancelPointer();
        if (!source.length) return;
        target.push(this.snapshot());
        this.model = NucleotideModel.fromJSON(JSON.parse(source.pop()));
        this.select(null);
        this.persist();
        this.render();
        this.showMessage(message);
    }

    startPointer(event) {
        if (event.button !== 0 || !event.isPrimary || this.interaction) return;
        this.cancelledPointerId = null;
        this.suppressClick = false;
        const element = event.target.closest('.canvas-component');
        if (!element && !this.rotationMode) return;
        const id = this.rotationMode ? this.selectedId : element.id;
        const component = this.components.find(c => c.id === id);
        if (!component) return;
        const point = this.canvasPoint(event);
        const ids = new Set(this.model.getConnectedIds(id));
        this.interaction = {
            pointerId: event.pointerId, capture: element || this.workCanvas,
            before: this.snapshot(), start: point, moved: false, rotation: this.rotationMode,
            center: { x: component.x + 30, y: component.y + 30 },
            previousAngle: Math.atan2(point.y - component.y - 30, point.x - component.x - 30),
            totalAngle: 0,
            positions: this.components.filter(c => ids.has(c.id)).map(c => ({ ...c }))
        };
        this.interaction.capture.setPointerCapture(event.pointerId);
    }

    movePointer(event) {
        const drag = this.interaction;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const point = this.canvasPoint(event);
        const dx = point.x - drag.start.x, dy = point.y - drag.start.y;
        if (!drag.moved && Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        event.preventDefault();
        if (drag.rotation) {
            const angle = Math.atan2(point.y - drag.center.y, point.x - drag.center.x);
            let delta = angle - drag.previousAngle;
            if (delta > Math.PI) delta -= 2 * Math.PI;
            if (delta < -Math.PI) delta += 2 * Math.PI;
            drag.totalAngle += delta * 180 / Math.PI * (event.shiftKey ? 0.2 : 1);
            drag.previousAngle = angle;
            this.applyRotation(drag.positions, drag.center, drag.totalAngle);
        } else {
            this.applyTranslation(drag.positions, dx, dy);
        }
        this.renderPositions();
    }

    endPointer(event) {
        const drag = this.interaction;
        if (!drag || drag.pointerId !== event.pointerId) return;
        this.interaction = null;
        if (drag.capture.hasPointerCapture(event.pointerId)) drag.capture.releasePointerCapture(event.pointerId);
        if (drag.moved) {
            this.suppressClick = true;
            setTimeout(() => { this.suppressClick = false; }, 0);
            try {
                this.remember(drag.before);
                this.showMessage(drag.rotation ? '已旋轉整組' : '已移動整組');
            } catch (error) {
                this.model = NucleotideModel.fromJSON(JSON.parse(drag.before));
                this.showMessage(error.message, 'error');
            }
            this.render();
        }
    }

    cancelPointer() {
        const drag = this.interaction;
        if (!drag) return;
        this.interaction = null;
        this.cancelledPointerId = drag.pointerId;
        this.suppressClick = true;
        if (drag.capture.hasPointerCapture(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
        this.model = NucleotideModel.fromJSON(JSON.parse(drag.before));
        this.renderPositions();
    }

    applyTranslation(positions, dx, dy) {
        dx = Math.max(-Math.min(...positions.map(c => c.x)), Math.min(dx,
            Math.min(this.workCanvas.clientWidth - 60, NucleotideModel.MAX_COORDINATE) - Math.max(...positions.map(c => c.x))));
        dy = Math.max(-Math.min(...positions.map(c => c.y)), Math.min(dy,
            Math.min(this.workCanvas.clientHeight - 60, NucleotideModel.MAX_COORDINATE) - Math.max(...positions.map(c => c.y))));
        const byId = new Map(this.components.map(c => [c.id, c]));
        positions.forEach(initial => Object.assign(byId.get(initial.id), { x: initial.x + dx, y: initial.y + dy }));
    }

    applyRotation(positions, center, degrees) {
        const angle = degrees * Math.PI / 180;
        const rotated = positions.map(c => {
            const x = c.x + 30 - center.x, y = c.y + 30 - center.y;
            return { id: c.id, x: center.x + x * Math.cos(angle) - y * Math.sin(angle) - 30,
                y: center.y + x * Math.sin(angle) + y * Math.cos(angle) - 30,
                rotation: ((c.rotation + degrees) % 360 + 360) % 360 };
        });
        const offsetX = Math.max(0, -Math.min(...rotated.map(c => c.x)));
        const offsetY = Math.max(0, -Math.min(...rotated.map(c => c.y)));
        const byId = new Map(this.components.map(c => [c.id, c]));
        rotated.forEach(c => Object.assign(byId.get(c.id), { x: c.x + offsetX, y: c.y + offsetY, rotation: c.rotation }));
    }

    rotateSelected(degrees) {
        if (!this.selectedId) return;
        this.change(() => {
            const selected = this.selectedComponent;
            if (!selected) return;
            const ids = new Set(this.model.getConnectedIds(selected.id));
            this.applyRotation(this.components.filter(c => ids.has(c.id)), { x: selected.x + 30, y: selected.y + 30 }, degrees);
        }, '已旋轉整組');
    }

    deleteSelected() {
        if (!this.selectedId) return;
        this.change(() => { this.model.removeComponent(this.selectedId); this.select(null); }, '已刪除組件，可復原');
        this.workCanvas.focus();
    }

    handleKey(event) {
        if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) this.redo(); else this.undo();
            return;
        }
        if (event.key === 'Escape') { this.cancelPointer(); this.select(null); this.showMessage('已取消選取'); return; }
        const element = event.target.closest('.canvas-component');
        if (!element || event.ctrlKey || event.metaKey || event.altKey) return;
        if (['Delete', 'Backspace', '[', ']', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            this.select(element.id);
            if (event.key === 'Delete' || event.key === 'Backspace') this.deleteSelected();
            else if (event.key === '[' || event.key === ']') this.rotateSelected(event.key === '[' ? -15 : 15);
            else {
                const step = event.shiftKey ? 1 : 10;
                const offsets = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
                this.change(() => {
                    const ids = new Set(this.model.getConnectedIds(element.id));
                    this.applyTranslation(this.components.filter(c => ids.has(c.id)), ...offsets[event.key]);
                });
            }
        }
    }

    render() {
        if (!this.selectedComponent) this.select(null);
        const ids = new Set(this.components.map(c => c.id));
        for (const [id, element] of this.componentElements) {
            if (!ids.has(id)) { element.remove(); this.componentElements.delete(id); }
        }
        for (const component of this.components) {
            const signature = [component.type, component.base, component.sugarType].join(':');
            const existing = this.componentElements.get(component.id);
            if (existing && existing.dataset.componentSignature !== signature) {
                existing.remove();
                this.componentElements.delete(component.id);
            }
            if (this.componentElements.has(component.id)) continue;
            const original = this.palette.find(button => button.dataset.type === component.type &&
                button.dataset.base === component.base && button.dataset.sugarType === component.sugarType);
            const element = original.cloneNode(true);
            element.id = component.id;
            element.dataset.componentSignature = signature;
            element.draggable = false;
            element.classList.add('canvas-component');
            element.setAttribute('aria-label', `${original.getAttribute('aria-label').replace(/^加入/, '')}，畫布組件 ${Number(component.id.split('-').pop()) + 1}`);
            element.title = '點選連線；拖動移動；方向鍵移動；Delete 刪除';
            this.componentElements.set(component.id, element);
            this.workCanvas.appendChild(element);
        }
        const bondIds = new Set(this.connections.map(c => c.id));
        for (const [id, element] of this.connectionElements) {
            if (!bondIds.has(id)) { element.remove(); this.connectionElements.delete(id); }
        }
        for (const connection of this.connections) {
            const element = this.connectionElements.get(connection.id) || document.createElement('button');
            element.type = 'button';
            element.className = `connection-line ${connection.bondType}`;
            element.dataset.connectionId = connection.id;
            const names = { 'strong-bond': '磷酸與糖之間的共價鍵', 'weak-bond': '糖苷鍵（共價鍵）', 'hydrogen-bond': '鹼基配對（氫鍵）' };
            const label = `${names[connection.bondType]}；點選移除 ${connection.from} 與 ${connection.to} 的連線`;
            element.setAttribute('aria-label', label);
            element.title = label;
            if (!this.connectionElements.has(connection.id)) {
                this.connectionElements.set(connection.id, element);
                this.workCanvas.appendChild(element);
            }
        }
        // Grow for imported work or rotated groups, while retaining a usable mobile canvas.
        this.workCanvas.style.minWidth = `${Math.max(640, ...this.components.map(c => c.x + 90))}px`;
        this.workCanvas.style.minHeight = `${Math.max(480, ...this.components.map(c => c.y + 90))}px`;
        this.workCanvas.querySelector('.canvas-hint').hidden = this.components.length > 0;
        document.getElementById('component-count').textContent = this.components.length;
        document.getElementById('connection-count').textContent = this.connections.length;
        document.getElementById('nucleotide-count').textContent = this.components.filter(c => c.type === 'sugar' &&
            this.neighborTypes(c.id).has('phosphate') && this.neighborTypes(c.id).has('base')).length;
        document.getElementById('undo').disabled = !this.undoStack.length;
        document.getElementById('redo').disabled = !this.redoStack.length;
        document.getElementById('clear-all').disabled = !this.components.length;
        this.renderPositions();
        this.renderSelection();
    }

    neighborTypes(id) {
        const ids = new Set(this.connections.filter(c => c.from === id || c.to === id).map(c => c.from === id ? c.to : c.from));
        return new Set(this.components.filter(c => ids.has(c.id)).map(c => c.type));
    }

    renderPositions() {
        const byId = new Map(this.components.map(c => [c.id, c]));
        for (const component of this.components) {
            const element = this.componentElements.get(component.id);
            if (!element) continue;
            element.style.left = `${component.x}px`;
            element.style.top = `${component.y}px`;
            element.style.setProperty('--component-rotate', `${component.rotation}deg`);
        }
        for (const connection of this.connections) {
            const from = byId.get(connection.from), to = byId.get(connection.to);
            const element = this.connectionElements.get(connection.id);
            if (!element) continue;
            const dx = to.x - from.x, dy = to.y - from.y;
            element.style.left = `${from.x + 30}px`;
            element.style.top = `${from.y + 30}px`;
            element.style.width = `${Math.hypot(dx, dy)}px`;
            element.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`;
        }
    }

    renderSelection() {
        for (const [id, element] of this.componentElements) {
            element.classList.toggle('selected', id === this.selectedId);
            element.classList.toggle('rotation-mode', id === this.selectedId && this.rotationMode);
            element.setAttribute('aria-pressed', String(id === this.selectedId));
        }
        this.workCanvas.classList.toggle('connection-mode', Boolean(this.selectedId) && !this.rotationMode);
        this.workCanvas.classList.toggle('rotation-mode', this.rotationMode);
        const indicator = document.getElementById('mode-indicator');
        indicator.textContent = this.rotationMode ? '旋轉模式' : this.selectedId ? '已選取組件' : '';
        indicator.classList.toggle('show', Boolean(this.selectedId));
        document.getElementById('selected-toolbar').hidden = !this.selectedId;
    }

    showMessage(message, type = 'info') {
        const result = document.getElementById('validation-result');
        result.textContent = message;
        result.className = `validation-result ${type}`;
    }

    persist() {
        try {
            localStorage.setItem(NucleotideSimulator.STORAGE_KEY, this.snapshot());
            document.getElementById('save-status').textContent = '已自動儲存在此瀏覽器';
        } catch {
            document.getElementById('save-status').textContent = '無法自動儲存，請匯出 JSON 保留作品';
        }
    }

    restore() {
        try {
            const saved = localStorage.getItem(NucleotideSimulator.STORAGE_KEY);
            if (saved) {
                this.model = NucleotideModel.fromJSON(JSON.parse(saved));
                this.showMessage('已還原上次的作品');
            }
        } catch {
            this.showMessage('無法讀取上次儲存的作品；仍可使用畫布或匯入 JSON', 'error');
        }
    }

    exportProject() {
        this.cancelPointer();
        const blob = new Blob([JSON.stringify(this.model.toJSON(), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'nucleotide-project.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.showMessage('已匯出作品 JSON');
    }

    async importProject(event) {
        const input = event.target;
        const file = input.files[0];
        if (!file) return;
        try {
            if (file.size > 1024 * 1024) throw new Error('檔案太大，請選擇 1 MB 以下的作品 JSON');
            const data = JSON.parse(await file.text());
            const imported = NucleotideModel.fromJSON(data);
            this.change(() => { this.model = imported; this.select(null); }, '已匯入作品，可復原');
        } catch (error) {
            this.showMessage(`無法匯入，原作品已保留：${error instanceof SyntaxError ? 'JSON 格式錯誤' : error.message}`, 'error');
        } finally {
            input.value = '';
        }
    }

    loadExample(type) {
        this.change(() => {
            const model = new NucleotideModel();
            const sugarType = type === 'DNA' ? 'deoxyribose' : 'ribose';
            const rows = type === 'DNA' ? [['A', 'C'], ['T', 'G']] : [['A', 'U', 'C', 'G']];
            const bases = [];
            rows.forEach((row, rowIndex) => {
                let previousSugar;
                row.forEach((base, column) => {
                    const x = 45 + column * 155, y = 80 + rowIndex * 270;
                    const phosphate = model.addComponent({ type: 'phosphate', x, y });
                    const sugar = model.addComponent({ type: 'sugar', sugarType, x: x + 75, y });
                    const baseComponent = model.addComponent({ type: 'base', base, x: x + 75, y: y + (rowIndex ? -85 : 85) });
                    model.connect(phosphate.id, sugar.id);
                    model.connect(sugar.id, baseComponent.id);
                    if (previousSugar) model.connect(previousSugar.id, phosphate.id);
                    previousSugar = sugar;
                    bases.push(baseComponent);
                });
            });
            if (type === 'DNA') {
                model.connect(bases[0].id, bases[2].id);
                model.connect(bases[1].id, bases[3].id);
            }
            this.model = model;
            this.select(null);
        }, `已載入 ${type} 示範，可復原回原作品`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.NucleotideSimulator = new NucleotideSimulator();
});
