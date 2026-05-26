import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  CalculationResult,
  CalculationTask,
  Consumption,
  Production,
  Workspace,
} from './api.service';

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
  protected readonly calculateError = signal<string | null>(null);

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
    if (hovered == null || hovered === taskId) return null;
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

  ngOnInit(): void {
    this.api.getWorkspace().subscribe((ws) => this.workspace.set(ws));
    this.api.listWorkspaces().subscribe((rows) => this.workspaces.set(rows));
    this.api.listProductions().subscribe((rows) => this.productions.set(rows));
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
    this.api.listProductions().subscribe((rows) => this.productions.set(rows));
  }

  addRow(): void {
    this.api.createProduction().subscribe((row) => {
      row.consumptions = row.consumptions ?? [];
      this.productions.update((rows) => [...rows, row]);
    });
  }

  deleteRow(p: Production): void {
    this.api
      .deleteProduction(p.id)
      .subscribe(() =>
        this.productions.update((rows) => rows.filter((r) => r.id !== p.id)),
      );
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
