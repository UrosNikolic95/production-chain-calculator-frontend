import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ApiService,
  CalculationResult,
  Consumption,
  Production,
} from './api.service';

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  private readonly api = inject(ApiService);

  protected readonly productions = signal<Production[]>([]);
  protected readonly result = signal<CalculationResult | null>(null);

  ngOnInit(): void {
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

  onConsumedNameChange(c: Consumption, name: string): void {
    const target = this.productions().find((p) => p.name === name.trim());
    c.consumedProductionId = target ? target.id : null;
    this.saveConsumption(c, 'consumedProductionId');
  }

  consumedName(c: Consumption): string {
    if (c.consumedProductionId == null) return '';
    return (
      this.productions().find((p) => p.id === c.consumedProductionId)?.name ??
      ''
    );
  }

  calculate(): void {
    this.api.calculate().subscribe((res) => this.result.set(res));
  }
}
