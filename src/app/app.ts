import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  CalculationLine,
  CalculationResult,
  CalculationTask,
  Consumption,
  Production,
  ProductionLine,
  Workspace,
} from './api.service';

/** A production line's position on the fake logistics map, in percent (0–100). */
interface MapPos {
  x: number;
  y: number;
}

/**
 * One physical production line of a resource. A resource (production) with a
 * `productionLines` value of N owns N lines, each independently placed on the
 * map. Positions are keyed by the ProductionLine id.
 */
interface LineSlot {
  id: number;
  productionId: number;
  lineIndex: number;
  /** Production name. */
  name: string;
  /** Total lines on the parent production (used to label "#2" etc.). */
  lineCount: number;
}

/**
 * Logistics mode. `off` hides the map and treats transport as instant; the
 * other three show the map: `view` just displays the existing locations,
 * `random` re-scatters them, `manual` lets you click to place each line.
 */
type TransportMode = 'off' | 'view' | 'random' | 'manual';

/** A derived transport leg shown as its own task in the timeline. */
interface TransportEdge {
  id: string;
  label: string;
  /** Producer/consumer production line ids (used for distance). */
  fromId: number;
  toId: number;
  /** Producer/consumer timeline task ids (used for hover highlighting). */
  producerTaskId: number;
  consumerTaskId: number;
  startTime: number;
  endTime: number;
  time: number;
  distance: number;
}

/** A supply route drawn on the map between two placed production lines. */
interface MapRoute {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A transport shipment in flight, drawn as a dot on the map during playback. */
interface TransportDot {
  x: number;
  y: number;
  label: string;
}

/** The produced-so-far segment of a line's currently running task. */
interface LineProgress {
  left: number;
  width: number;
}

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);

  protected readonly workspace = signal<Workspace | null>(null);
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly productions = signal<Production[]>([]);
  protected readonly result = signal<CalculationResult | null>(null);
  protected readonly hoveredTaskId = signal<number | null>(null);
  protected readonly hoveredEdgeId = signal<string | null>(null);
  protected readonly calculateError = signal<string | null>(null);

  // ---------- Logistics map ----------

  protected readonly transportMode = signal<TransportMode>('off');
  protected readonly transportSpeed = signal<number>(20);
  /** Positions keyed by ProductionLine id, in percent (0–100) of the map. */
  protected readonly positions = signal<Record<number, MapPos>>({});
  /** ProductionLine ids waiting to be placed manually, in placement order. */
  protected readonly placementQueue = signal<number[]>([]);

  protected readonly tooltip = signal<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  protected showTooltip(t: CalculationTask, event: MouseEvent): void {
    this.tooltip.set({
      text: this.taskTooltip(t),
      x: event.clientX,
      y: event.clientY,
    });
  }

  protected moveTooltip(event: MouseEvent): void {
    this.tooltip.update((tip) =>
      tip ? { ...tip, x: event.clientX, y: event.clientY } : tip,
    );
  }

  protected hideTooltip(): void {
    this.tooltip.set(null);
  }

  protected showTextTooltip(text: string, event: MouseEvent): void {
    this.tooltip.set({ text, x: event.clientX, y: event.clientY });
  }

  protected taskTooltip(t: CalculationTask): string {
    return [
      `Resource: ${t.name}`,
      `Start time: ${t.startTime.toFixed(2)}`,
      `End time: ${t.endTime.toFixed(2)}`,
      `Length: ${(t.endTime - t.startTime).toFixed(2)}`,
      `Quantity: ${t.quantity}`,
    ].join('\n');
  }

  protected hoverHighlight(taskId: number): 'dep' | 'req' | null {
    const hovered = this.hoveredTaskId();
    if (hovered != null) {
      if (hovered === taskId) return null;
      const r = this.result();
      if (!r) return null;
      for (const line of r.lines) {
        for (const t of line.tasks) {
          if (t.id !== hovered) continue;
          if (t.dependsOnIds.includes(taskId)) return 'dep';
          if (t.requiredByIds.includes(taskId)) return 'req';
          return null;
        }
      }
      return null;
    }
    // A transport block is hovered: light up its producer (source) and
    // consumer (destination) production blocks.
    const edgeId = this.hoveredEdgeId();
    if (edgeId != null) {
      const edge = this.transportEdges().find((e) => e.id === edgeId);
      if (edge) {
        if (edge.producerTaskId === taskId) return 'dep';
        if (edge.consumerTaskId === taskId) return 'req';
      }
    }
    return null;
  }

  /** Whether a transport block should be highlighted given the current hover. */
  protected transportActive(e: TransportEdge): boolean {
    if (this.hoveredEdgeId() === e.id) return true;
    const hovered = this.hoveredTaskId();
    return (
      hovered != null &&
      (e.producerTaskId === hovered || e.consumerTaskId === hovered)
    );
  }

  ngOnInit(): void {
    this.api.getWorkspace().subscribe((ws) => this.workspace.set(ws));
    this.api.listWorkspaces().subscribe((rows) => this.workspaces.set(rows));
    this.api.listProductions().subscribe((rows) => {
      this.productions.set(rows);
      this.syncPositions();
    });
  }

  /**
   * Keep map state consistent after the production/line set changes: seed newly
   * added lines from their persisted backend position, keep positions already
   * placed this session, and drop lines that no longer exist.
   */
  private syncPositions(): void {
    const slots = this.lineSlots();
    const ids = new Set(slots.map((s) => s.id));
    this.positions.update((pos) => {
      const next: Record<number, MapPos> = {};
      for (const s of slots) {
        if (pos[s.id]) {
          next[s.id] = pos[s.id];
        } else {
          const line = this.lineById(s.id);
          if (line) next[s.id] = { x: line.positionX, y: line.positionY };
        }
      }
      return next;
    });
    this.placementQueue.update((q) => q.filter((id) => ids.has(id)));

    if (this.transportMode() === 'manual') {
      // Queue any newly added, still-unplaced lines.
      const pos = this.positions();
      const queued = new Set(this.placementQueue());
      const missing = slots
        .filter((s) => !pos[s.id] && !queued.has(s.id))
        .map((s) => s.id);
      if (missing.length) {
        this.placementQueue.update((q) => [...q, ...missing]);
      }
    }
  }

  createWorkspace(): void {
    const name = (prompt('New workspace name') ?? '').trim();
    if (!name) return;
    this.api.createWorkspace(name).subscribe((ws) => {
      this.workspaces.update((rows) => [...rows, ws]);
      this.activateWorkspace(ws);
    });
  }

  onWorkspaceChange(id: number): void {
    const ws = this.workspaces().find((w) => w.id === id);
    if (!ws || ws.id === this.workspace()?.id) return;
    this.api.selectWorkspace(ws.id).subscribe(() => this.activateWorkspace(ws));
  }

  private activateWorkspace(ws: Workspace): void {
    this.workspace.set(ws);
    this.result.set(null);
    this.calculateError.set(null);
    this.api.listProductions().subscribe((rows) => {
      this.productions.set(rows);
      this.syncPositions();
    });
  }

  addRow(): void {
    this.api.createProduction().subscribe((row) => {
      row.consumptions = row.consumptions ?? [];
      this.productions.update((rows) => [...rows, row]);
      this.syncPositions();
    });
  }

  deleteRow(p: Production): void {
    this.api.deleteProduction(p.id).subscribe(() => {
      this.productions.update((rows) => rows.filter((r) => r.id !== p.id));
      this.syncPositions();
    });
  }

  saveProduction(p: Production, field: keyof Production): void {
    const patch = { [field]: p[field] } as Partial<Production>;
    this.api.updateProduction(p.id, patch).subscribe((res) => {
      // Changing the line count adds/removes line rows on the backend; adopt the
      // refreshed set so the map shows one pin per line.
      if (field === 'productionLines' && res.lines) {
        p.lines = res.lines;
        this.productions.update((rows) => [...rows]);
        this.syncPositions();
      }
    });
  }

  addConsumption(p: Production): void {
    this.api.createConsumption(p.id).subscribe((c) => {
      this.productions.update((rows) =>
        rows.map((row) =>
          row.id === p.id
            ? { ...row, consumptions: [...(row.consumptions ?? []), c] }
            : row,
        ),
      );
    });
  }

  deleteConsumption(p: Production, c: Consumption): void {
    this.api.deleteConsumption(c.id).subscribe(() => {
      this.productions.update((rows) =>
        rows.map((row) =>
          row.id === p.id
            ? {
                ...row,
                consumptions: row.consumptions.filter((x) => x.id !== c.id),
              }
            : row,
        ),
      );
    });
  }

  saveConsumption(c: Consumption, field: keyof Consumption): void {
    const patch = { [field]: c[field] } as Partial<Consumption>;
    this.api.updateConsumption(c.id, patch).subscribe();
  }

  onConsumedChange(c: Consumption, value: number | null): void {
    c.consumedProductionId = value ?? null;
    this.saveConsumption(c, 'consumedProductionId');
  }

  // Resources available to consume: other productions in the current workspace.
  consumableResources(p: Production): Production[] {
    return this.productions().filter((r) => r.id !== p.id && !!r.name.trim());
  }

  // ---------- Logistics map ----------

  /** Every physical production line, one entry per line of every production. */
  protected readonly lineSlots = computed<LineSlot[]>(() => {
    const out: LineSlot[] = [];
    for (const p of this.productions()) {
      const lines = (p.lines ?? [])
        .slice()
        .sort((a, b) => a.lineIndex - b.lineIndex);
      for (const l of lines) {
        out.push({
          id: l.id,
          productionId: p.id,
          lineIndex: l.lineIndex,
          name: p.name,
          lineCount: lines.length,
        });
      }
    }
    return out;
  });

  private lineById(id: number): ProductionLine | undefined {
    for (const p of this.productions()) {
      const l = (p.lines ?? []).find((x) => x.id === id);
      if (l) return l;
    }
    return undefined;
  }

  /** The line id currently selected for placement (front of the queue). */
  protected readonly selectedForPlacement = computed<number | null>(
    () => this.placementQueue()[0] ?? null,
  );

  protected readonly isPlacing = computed(
    () => this.transportMode() === 'manual' && this.placementQueue().length > 0,
  );

  /** Production lines that have a position on the map. */
  protected readonly placedLines = computed<LineSlot[]>(() => {
    const pos = this.positions();
    return this.lineSlots().filter((s) => pos[s.id]);
  });

  /**
   * Supply routes: a segment from every line of a consumed production to every
   * line of its consumer.
   */
  protected readonly routes = computed<MapRoute[]>(() => {
    const pos = this.positions();
    const byProduction = new Map<number, LineSlot[]>();
    for (const s of this.lineSlots()) {
      const arr = byProduction.get(s.productionId) ?? [];
      arr.push(s);
      byProduction.set(s.productionId, arr);
    }
    const out: MapRoute[] = [];
    for (const p of this.productions()) {
      const toSlots = byProduction.get(p.id) ?? [];
      for (const c of p.consumptions ?? []) {
        if (c.consumedProductionId == null) continue;
        const fromSlots = byProduction.get(c.consumedProductionId) ?? [];
        for (const from of fromSlots) {
          const a = pos[from.id];
          if (!a) continue;
          for (const to of toSlots) {
            const b = pos[to.id];
            if (!b) continue;
            out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        }
      }
    }
    return out;
  });

  protected posOf(id: number): MapPos | undefined {
    return this.positions()[id];
  }

  /** Display label for a line: name, suffixed with "#n" when it has siblings. */
  protected slotLabel(s: LineSlot): string {
    const base = s.name?.trim() || `Line ${s.productionId}`;
    return s.lineCount > 1 ? `${base} #${s.lineIndex + 1}` : base;
  }

  protected lineLabel(id: number): string {
    const s = this.lineSlots().find((x) => x.id === id);
    return s ? this.slotLabel(s) : `Line ${id}`;
  }

  private lineCountOf(productionId: number): number {
    return (
      this.productions().find((p) => p.id === productionId)?.lines?.length ?? 1
    );
  }

  /** Label a calculation task/line, adding "#n" when the production has siblings. */
  protected taskLineLabel(name: string, productionId: number, lineIndex: number): string {
    const base = name?.trim() || `Line ${productionId}`;
    return this.lineCountOf(productionId) > 1 ? `${base} #${lineIndex + 1}` : base;
  }

  private randomPos(): MapPos {
    // Keep pins away from the very edges so labels stay readable.
    return { x: 8 + Math.random() * 84, y: 10 + Math.random() * 80 };
  }

  private persistPosition(lineId: number, pos: MapPos): void {
    this.api
      .updateProductionLine(lineId, { positionX: pos.x, positionY: pos.y })
      .subscribe();
  }

  /** Show the map, displaying the lines' already-existing locations. */
  protected setWithMap(): void {
    if (this.transportMode() === 'off') this.transportMode.set('view');
  }

  /** Hide the map; transport becomes instant. */
  protected setWithoutMap(): void {
    this.transportMode.set('off');
    this.placementQueue.set([]);
  }

  protected setRandom(): void {
    this.transportMode.set('random');
    this.placementQueue.set([]);
    const next: Record<number, MapPos> = {};
    for (const s of this.lineSlots()) {
      const pos = this.randomPos();
      next[s.id] = pos;
      this.persistPosition(s.id, pos);
    }
    this.positions.set(next);
  }

  protected setManual(): void {
    this.transportMode.set('manual');
    // Clear the map and queue every production line up for manual placement.
    this.positions.set({});
    this.placementQueue.set(this.lineSlots().map((s) => s.id));
  }

  protected onMapClick(event: MouseEvent): void {
    const id = this.selectedForPlacement();
    if (this.transportMode() !== 'manual' || id == null) return;
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const clamp = (n: number) => Math.max(0, Math.min(100, n));
    const pos = { x: clamp(x), y: clamp(y) };
    this.positions.update((prev) => ({ ...prev, [id]: pos }));
    this.placementQueue.update((q) => q.slice(1));
    this.persistPosition(id, pos);
  }

  /** Transport time between two production lines, in timeline units. */
  protected transportTime(fromLineId: number, toLineId: number): number {
    if (this.transportMode() === 'off') return 0;
    if (fromLineId === toLineId) return 0;
    const a = this.positions()[fromLineId];
    const b = this.positions()[toLineId];
    if (!a || !b) return 0;
    return this.distance(fromLineId, toLineId) / (this.transportSpeed() || 1);
  }

  private distance(fromLineId: number, toLineId: number): number {
    const a = this.positions()[fromLineId];
    const b = this.positions()[toLineId];
    if (!a || !b) return 0;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Re-derive task start/end times so transport time delays consumers.
   *
   * The backend schedule assumes instant transport. Here we replay it as an
   * earliest-start schedule where a task cannot begin until every dependency
   * has finished *and* been transported to it (producerEnd + transportTime),
   * and tasks on the same line still run in their original sequence. Durations
   * are preserved; times only ever move later. Returns a map task id → times.
   */
  protected readonly schedule = computed<Map<number, { start: number; end: number }>>(() => {
    const r = this.result();
    const sched = new Map<number, { start: number; end: number }>();
    if (!r) return sched;

    const taskById = new Map<number, CalculationTask>();
    // Predecessors for scheduling: real dependencies + the previous task on
    // the same line (so a line stays sequential).
    const preds = new Map<number, number[]>();
    const indeg = new Map<number, number>();
    const succ = new Map<number, number[]>();

    for (const line of r.lines) {
      let linePrev: number | null = null;
      for (const t of line.tasks) {
        taskById.set(t.id, t);
        const ps = [...t.dependsOnIds];
        if (linePrev != null && !ps.includes(linePrev)) ps.push(linePrev);
        preds.set(t.id, ps);
        indeg.set(t.id, ps.length);
        if (!succ.has(t.id)) succ.set(t.id, []);
        linePrev = t.id;
      }
    }
    for (const [id, ps] of preds) {
      for (const pr of ps) {
        if (!succ.has(pr)) succ.set(pr, []);
        succ.get(pr)!.push(id);
      }
    }

    // Kahn topological order, relaxing start times as we go.
    const queue: number[] = [];
    for (const [id, d] of indeg) if (d === 0) queue.push(id);
    let processed = 0;
    while (queue.length) {
      const id = queue.shift()!;
      processed++;
      const t = taskById.get(id)!;
      const duration = t.endTime - t.startTime;
      let start = 0;
      for (const pr of preds.get(id) ?? []) {
        const prSched = sched.get(pr);
        const prTask = taskById.get(pr);
        if (!prSched || !prTask) continue;
        // Same-line predecessors (line order) have zero transport; a
        // dependency on a different line pays the transport delay.
        const delay = this.transportTime(prTask.lineId, t.lineId);
        start = Math.max(start, prSched.end + delay);
      }
      sched.set(id, { start, end: start + duration });
      for (const nx of succ.get(id) ?? []) {
        indeg.set(nx, (indeg.get(nx) ?? 0) - 1);
        if (indeg.get(nx) === 0) queue.push(nx);
      }
    }
    // Fallback for any task left unscheduled (e.g. an unexpected cycle).
    if (processed < taskById.size) {
      for (const t of taskById.values()) {
        if (!sched.has(t.id)) sched.set(t.id, { start: t.startTime, end: t.endTime });
      }
    }
    return sched;
  });

  /** Calculation lines with transport-delayed start/end times applied. */
  protected readonly scheduledLines = computed<CalculationLine[]>(() => {
    const r = this.result();
    if (!r) return [];
    const sched = this.schedule();
    return r.lines.map((line) => ({
      ...line,
      tasks: line.tasks.map((t) => {
        const s = sched.get(t.id);
        return s ? { ...t, startTime: s.start, endTime: s.end } : t;
      }),
    }));
  });

  /** Transport legs derived from the calculation's dependency edges. */
  protected readonly transportEdges = computed<TransportEdge[]>(() => {
    const r = this.result();
    if (!r) return [];
    const sched = this.schedule();
    const taskById = new Map<number, CalculationTask>();
    for (const line of r.lines) {
      for (const t of line.tasks) taskById.set(t.id, t);
    }
    const edges: TransportEdge[] = [];
    for (const line of r.lines) {
      for (const t of line.tasks) {
        for (const depId of t.dependsOnIds) {
          const producer = taskById.get(depId);
          if (!producer) continue;
          const time = this.transportTime(producer.lineId, t.lineId);
          if (time <= 0) continue;
          const producerEnd = sched.get(depId)?.end ?? producer.endTime;
          const fromLabel = this.taskLineLabel(
            producer.name,
            producer.productionId,
            producer.lineIndex,
          );
          const toLabel = this.taskLineLabel(t.name, t.productionId, t.lineIndex);
          edges.push({
            id: `${depId}-${t.id}`,
            label: `${fromLabel} → ${toLabel}`,
            fromId: producer.lineId,
            toId: t.lineId,
            producerTaskId: producer.id,
            consumerTaskId: t.id,
            startTime: producerEnd,
            endTime: producerEnd + time,
            time,
            distance: this.distance(producer.lineId, t.lineId),
          });
        }
      }
    }
    return edges;
  });

  protected transportTooltip(e: TransportEdge): string {
    return [
      `Transport: ${e.label}`,
      `Distance: ${e.distance.toFixed(1)}`,
      `Speed: ${this.transportSpeed()}`,
      `Start time: ${e.startTime.toFixed(2)}`,
      `End time: ${e.endTime.toFixed(2)}`,
      `Duration: ${e.time.toFixed(2)}`,
    ].join('\n');
  }

  // ---------- Simulation playback ----------

  protected readonly simRunning = signal(false);
  /** Current simulation moment, in timeline units (cm), same scale as tasks. */
  protected readonly simTime = signal(0);
  /** Playback rate in timeline units per real second. */
  protected readonly playbackSpeed = signal(3);
  private rafId: number | null = null;
  private lastFrame = 0;

  /** Total length of the schedule, i.e. when the last task/transport ends. */
  protected readonly simDuration = computed<number>(() => {
    let max = 0;
    for (const line of this.scheduledLines()) {
      for (const t of line.tasks) if (t.endTime > max) max = t.endTime;
    }
    for (const e of this.transportEdges()) if (e.endTime > max) max = e.endTime;
    return max;
  });

  protected toggleSimulation(): void {
    if (this.simRunning()) this.pauseSimulation();
    else this.playSimulation();
  }

  protected playSimulation(): void {
    if (!this.result() || this.simDuration() <= 0) return;
    // Replay from the start once the previous run has reached the end.
    if (this.simTime() >= this.simDuration()) this.simTime.set(0);
    this.simRunning.set(true);
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  protected pauseSimulation(): void {
    this.simRunning.set(false);
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  protected resetSimulation(): void {
    this.pauseSimulation();
    this.simTime.set(0);
  }

  private readonly tick = (now: number): void => {
    if (!this.simRunning()) return;
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const end = this.simDuration();
    const next = this.simTime() + dt * this.playbackSpeed();
    if (next >= end) {
      // Land exactly on the end, then stop (which hides the playhead).
      this.simTime.set(end);
      this.pauseSimulation();
      return;
    }
    this.simTime.set(next);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Shipments currently in flight, positioned along their route on the map. */
  protected readonly transportDots = computed<TransportDot[]>(() => {
    if (!this.simRunning()) return [];
    const t = this.simTime();
    const pos = this.positions();
    const dots: TransportDot[] = [];
    for (const e of this.transportEdges()) {
      if (t < e.startTime || t > e.endTime) continue;
      const a = pos[e.fromId];
      const b = pos[e.toId];
      if (!a || !b) continue;
      const span = e.endTime - e.startTime;
      const p = span > 0 ? (t - e.startTime) / span : 1;
      dots.push({
        x: a.x + (b.x - a.x) * p,
        y: a.y + (b.y - a.y) * p,
        label: e.label,
      });
    }
    return dots;
  });

  /**
   * Fraction (0–1) of the task currently running on production line `lineId`,
   * or null when nothing is in production there at the current moment. Used to
   * fill the progress bar above each map pin.
   */
  protected mapLineProgress(lineId: number): number | null {
    if (!this.simRunning()) return null;
    const t = this.simTime();
    for (const line of this.scheduledLines()) {
      if (line.lineId !== lineId) continue;
      for (const task of line.tasks) {
        if (t >= task.startTime && t < task.endTime) {
          const span = task.endTime - task.startTime;
          return span > 0 ? (t - task.startTime) / span : 1;
        }
      }
    }
    return null;
  }

  /** The produced-so-far segment of the task running on `line` right now. */
  protected activeProgress(line: CalculationLine): LineProgress | null {
    if (!this.simRunning()) return null;
    const t = this.simTime();
    for (const task of line.tasks) {
      if (t >= task.startTime && t < task.endTime) {
        return { left: task.startTime, width: t - task.startTime };
      }
    }
    return null;
  }

  ngOnDestroy(): void {
    this.pauseSimulation();
  }

  calculate(): void {
    this.calculateError.set(null);
    this.api.calculate().subscribe({
      next: (res) => this.result.set(res),
      error: (err) => {
        this.result.set(null);
        this.calculateError.set(
          err?.error?.message ?? err?.message ?? 'Calculation failed.',
        );
      },
    });
  }
}
