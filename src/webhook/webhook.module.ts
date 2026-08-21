// src/webhook/webhook.module.ts

import { Module } from '@nestjs/common';

import { BrainModule } from '../brain/brain.module';
import { CalendarModule } from '../calendar/calendar.module';
import { MemoryModule } from '../memory/memory.module';
import { ProvidersModule } from '../providers/providers.module';
import { FirmaMetaGuard } from './firma-meta.guard';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [ProvidersModule, BrainModule, MemoryModule, CalendarModule],
  controllers: [WebhookController],
  providers: [WebhookService, FirmaMetaGuard],
})
export class WebhookModule {}
