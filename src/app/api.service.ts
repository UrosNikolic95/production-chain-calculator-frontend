import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';

const API_BASE = environment.apiBase;

export interface Workspace {
  id: number;
  userId: number;
  name: string;
}

export interface Consumption {
  id: number;
  productionId: number;
  consumedProductionId: number | null;
  quantity: number;
}

/** One physical production line of a production, with its map position. */
export interface ProductionLine {
  id: number;
  productionId: number;
  lineIndex: number;
  positionX: number;
  positionY: number;
}

export interface Production {
  id: number;
  workspaceId: number;
  name: string;
  productionQuantity: number;
  targetQuantity: number;
  productionLines: number;
  productionTime: number;
  consumptions: Consumption[];
  lines: ProductionLine[];
}

export interface CalculationTask {
  id: number;
  productionId: number;
  lineId: number;
  lineIndex: number;
  name: string;
  quantity: number;
  startTime: number;
  endTime: number;
  dependsOnIds: number[];
  requiredByIds: number[];
}

export interface CalculationLine {
  productionId: number;
  lineId: number;
  lineIndex: number;
  name: string;
  tasks: CalculationTask[];
}

export interface CalculationResult {
  lines: CalculationLine[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  listWorkspaces(): Observable<Workspace[]> {
    return this.http.get<Workspace[]>(`${API_BASE}/workspaces`);
  }

  getWorkspace(): Observable<Workspace> {
    return this.http.get<Workspace>(`${API_BASE}/workspaces/current`);
  }

  createWorkspace(name: string): Observable<Workspace> {
    return this.http.post<Workspace>(`${API_BASE}/workspaces`, { name });
  }

  selectWorkspace(id: number): Observable<Workspace> {
    return this.http.post<Workspace>(`${API_BASE}/workspaces/select`, { id });
  }

  listProductions(): Observable<Production[]> {
    return this.http.get<Production[]>(`${API_BASE}/productions`);
  }

  createProduction(): Observable<Production> {
    return this.http.post<Production>(`${API_BASE}/productions`, {});
  }

  updateProduction(
    id: number,
    patch: Partial<Production>,
  ): Observable<Production> {
    return this.http.patch<Production>(`${API_BASE}/productions/${id}`, patch);
  }

  deleteProduction(id: number): Observable<void> {
    return this.http.delete<void>(`${API_BASE}/productions/${id}`);
  }

  createConsumption(productionId: number): Observable<Consumption> {
    return this.http.post<Consumption>(`${API_BASE}/consumptions`, {
      productionId,
    });
  }

  updateConsumption(
    id: number,
    patch: Partial<Consumption>,
  ): Observable<Consumption> {
    return this.http.patch<Consumption>(
      `${API_BASE}/consumptions/${id}`,
      patch,
    );
  }

  deleteConsumption(id: number): Observable<void> {
    return this.http.delete<void>(`${API_BASE}/consumptions/${id}`);
  }

  updateProductionLine(
    id: number,
    patch: { positionX?: number; positionY?: number },
  ): Observable<ProductionLine> {
    return this.http.patch<ProductionLine>(
      `${API_BASE}/production-lines/${id}`,
      patch,
    );
  }

  calculate(): Observable<CalculationResult> {
    return this.http.post<CalculationResult>(`${API_BASE}/calculate`, {});
  }
}
