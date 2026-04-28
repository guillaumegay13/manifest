import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import type { ModelRoute } from 'manifest-shared';
import { SpecificityAssignment } from '../../entities/specificity-assignment.entity';
import { RoutingCacheService } from './routing-cache.service';

@Injectable()
export class SpecificityService {
  constructor(
    @InjectRepository(SpecificityAssignment)
    private readonly repo: Repository<SpecificityAssignment>,
    private readonly routingCache: RoutingCacheService,
  ) {}

  async getAssignments(agentId: string): Promise<SpecificityAssignment[]> {
    const cached = this.routingCache.getSpecificity(agentId);
    if (cached) return cached;

    const rows = await this.repo.find({ where: { agent_id: agentId } });
    this.routingCache.setSpecificity(agentId, rows);
    return rows;
  }

  async getActiveAssignments(agentId: string): Promise<SpecificityAssignment[]> {
    const all = await this.getAssignments(agentId);
    return all.filter((a) => a.is_active);
  }

  async toggleCategory(
    agentId: string,
    userId: string,
    category: string,
    active: boolean,
  ): Promise<SpecificityAssignment> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });

    if (existing) {
      existing.is_active = active;
      existing.updated_at = new Date().toISOString();
      await this.repo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record = Object.assign(new SpecificityAssignment(), {
      id: randomUUID(),
      user_id: userId,
      agent_id: agentId,
      category,
      is_active: active,
      override_route: null,
      auto_assigned_route: null,
      fallback_routes: null,
    });

    try {
      await this.repo.insert(record);
    } catch {
      const retry = await this.repo.findOne({ where: { agent_id: agentId, category } });
      if (retry) return this.toggleCategory(agentId, userId, category, active);
    }
    this.routingCache.invalidateAgent(agentId);
    return record;
  }

  async setOverride(
    agentId: string,
    userId: string,
    category: string,
    route: ModelRoute,
  ): Promise<SpecificityAssignment> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });

    if (existing) {
      existing.override_route = route;
      existing.is_active = true;
      existing.updated_at = new Date().toISOString();
      await this.repo.save(existing);
      this.routingCache.invalidateAgent(agentId);
      return existing;
    }

    const record = Object.assign(new SpecificityAssignment(), {
      id: randomUUID(),
      user_id: userId,
      agent_id: agentId,
      category,
      is_active: true,
      override_route: route,
      auto_assigned_route: null,
      fallback_routes: null,
    });

    try {
      await this.repo.insert(record);
    } catch {
      const retry = await this.repo.findOne({ where: { agent_id: agentId, category } });
      if (retry) return this.setOverride(agentId, userId, category, route);
    }
    this.routingCache.invalidateAgent(agentId);
    return record;
  }

  async clearOverride(agentId: string, category: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (!existing) return;

    existing.override_route = null;
    existing.fallback_routes = null;
    existing.updated_at = new Date().toISOString();
    await this.repo.save(existing);
    this.routingCache.invalidateAgent(agentId);
  }

  async setFallbacks(
    agentId: string,
    category: string,
    routes: ModelRoute[],
  ): Promise<ModelRoute[]> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (!existing) return [];
    existing.fallback_routes = routes.length > 0 ? routes : null;
    existing.updated_at = new Date().toISOString();
    await this.repo.save(existing);
    this.routingCache.invalidateAgent(agentId);
    return routes;
  }

  async clearFallbacks(agentId: string, category: string): Promise<void> {
    const existing = await this.repo.findOne({ where: { agent_id: agentId, category } });
    if (!existing) return;
    existing.fallback_routes = null;
    existing.updated_at = new Date().toISOString();
    await this.repo.save(existing);
    this.routingCache.invalidateAgent(agentId);
  }

  async resetAll(agentId: string): Promise<void> {
    await this.repo.update(
      { agent_id: agentId },
      {
        is_active: false,
        override_route: null,
        fallback_routes: null,
        updated_at: new Date().toISOString(),
      },
    );
    this.routingCache.invalidateAgent(agentId);
  }
}
