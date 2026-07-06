import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  CalculationLine,
  CalculationResult,
  CalculationTask,
  Consumption,
  Production,
  Workspace,
} from './api.service';

/** A production line's position on the fake logistics map, in percent (0–100). */
interface MapPos {
  x: number;
  y: number;
}

/** Transport mode: how goods move between production lines. */
type TransportMode = 'instant' | 'random' | 'manual';

/** A derived transport leg shown as its own task in the timeline. */
interface TransportEdge {
  id: string;
  label: string;
  /** Producer/consumer production ids (used for distance). */
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

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private readonly api = inject(ApiService);

  protected readonly workspace = signal<Workspace | null>(null);
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly productions = signal<Production[]>([]);
  protected readonly result = signal<CalculationResult | null>(null);
  protected readonly hoveredTaskId = signal<number | null>(null);
  protected readonly hoveredEdgeId = signal<string | null>(null);
  protected readonly calculateError = signal<string | null>(null);

  // ---------- Logistics map ----------

  protected readonly transportMode = signal<TransportMode>('instant');
  protected readonly transportSpeed = signal<number>(20);
  /** Positions keyed by production id, in percent (0–100) of the map. */
  protected readonly positions = signal<Record<number, MapPos>>({});
  /** Production ids waiting to be placed manually, in placement order. */
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

  /** Keep map state consistent after the production set changes. */
  private syncPositions(): void {
    this.prunePositions();
    if (this.transportMode() === 'manual') {
      // Queue any newly added, still-unplaced productions.
      const pos = this.positions();
      const queued = new Set(this.placementQueue());
      const missing = this.productions()
        .filter((p) => !pos[p.id] && !queued.has(p.id))
        .map((p) => p.id);
      if (missing.length) {
        this.placementQueue.update((q) => [...q, ...missing]);
      }
    } else {
      this.ensurePositions();
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
    this.api.updateProduction(p.id, patch).subscribe();
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

  /** The production id currently selected for placement (front of the queue). */
  protected readonly selectedForPlacement = computed<number | null>(
    () => this.placementQueue()[0] ?? null,
  );

  protected readonly isPlacing = computed(
    () => this.transportMode() === 'manual' && this.placementQueue().length > 0,
  );

  /** Productions that have a position on the map. */
  protected readonly placedProductions = computed<Production[]>(() => {
    const pos = this.positions();
    return this.productions().filter((p) => pos[p.id]);
  });

  /** Supply routes: a line from each consumed production to its consumer. */
  protected readonly routes = computed<MapRoute[]>(() => {
    const pos = this.positions();
    const out: MapRoute[] = [];
    for (const p of this.productions()) {
      const to = pos[p.id];
      if (!to) continue;
      for (const c of p.consumptions ?? []) {
        if (c.consumedProductionId == null) continue;
        const from = pos[c.consumedProductionId];
        if (!from) continue;
        out.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
      }
    }
    return out;
  });

  protected posOf(id: number): MapPos | undefined {
    return this.positions()[id];
  }

  protected productionName(id: number): string {
    const p = this.productions().find((r) => r.id === id);
    return p?.name?.trim() || `Line ${id}`;
  }

  private randomPos(): MapPos {
    // Keep pins away from the very edges so labels stay readable.
    return { x: 8 + Math.random() * 84, y: 10 + Math.random() * 80 };
  }

  /** Give every production without a position a random one (non-manual modes). */
  private ensurePositions(): void {
    this.positions.update((pos) => {
      const next = { ...pos };
      let changed = false;
      for (const p of this.productions()) {
        if (!next[p.id]) {
          next[p.id] = this.randomPos();
          changed = true;
        }
      }
      return changed ? next : pos;
    });
  }

  /** Drop positions for productions that no longer exist. */
  private prunePositions(): void {
    const ids = new Set(this.productions().map((p) => p.id));
    this.positions.update((pos) => {
      const next: Record<number, MapPos> = {};
      for (const [k, v] of Object.entries(pos)) {
        if (ids.has(+k)) next[+k] = v;
      }
      return next;
    });
    this.placementQueue.update((q) => q.filter((id) => ids.has(id)));
  }

  protected setInstant(): void {
    this.transportMode.set('instant');
    this.placementQueue.set([]);
    this.ensurePositions();
  }

  protected setRandom(): void {
    this.transportMode.set('random');
    this.placementQueue.set([]);
    const next: Record<number, MapPos> = {};
    for (const p of this.productions()) next[p.id] = this.randomPos();
    this.positions.set(next);
  }

  protected setManual(): void {
    this.transportMode.set('manual');
    // Clear the map and queue every production up for manual placement.
    this.positions.set({});
    this.placementQueue.set(this.productions().map((p) => p.id));
  }

  protected onMapClick(event: MouseEvent): void {
    const id = this.selectedForPlacement();
    if (this.transportMode() !== 'manual' || id == null) return;
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const clamp = (n: number) => Math.max(0, Math.min(100, n));
    this.positions.update((pos) => ({
      ...pos,
      [id]: { x: clamp(x), y: clamp(y) },
    }));
    this.placementQueue.update((q) => q.slice(1));
  }

  /** Transport time between two production lines, in timeline units. */
  protected transportTime(fromId: number, toId: number): number {
    if (this.transportMode() === 'instant') return 0;
    const a = this.positions()[fromId];
    const b = this.positions()[toId];
    if (!a || !b) return 0;
    return this.distance(fromId, toId) / (this.transportSpeed() || 1);
  }

  private distance(fromId: number, toId: number): number {
    const a = this.positions()[fromId];
    const b = this.positions()[toId];
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
        // Same-production predecessors (line order) have zero transport;
        // cross-production dependencies pay the transport delay.
        const delay = this.transportTime(prTask.productionId, t.productionId);
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
          const time = this.transportTime(producer.productionId, t.productionId);
          if (time <= 0) continue;
          const producerEnd = sched.get(depId)?.end ?? producer.endTime;
          edges.push({
            id: `${depId}-${t.id}`,
            label: `${producer.name} → ${t.name}`,
            fromId: producer.productionId,
            toId: t.productionId,
            producerTaskId: producer.id,
            consumerTaskId: t.id,
            startTime: producerEnd,
            endTime: producerEnd + time,
            time,
            distance: this.distance(producer.productionId, t.productionId),
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
