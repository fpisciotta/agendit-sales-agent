// src/followup/followup.module.ts

import { Module } from '@nestjs/common';

import { BrainModule } from '../brain/brain.module';
import { MemoryModule } from '../memory/memory.module';
import { ProvidersModule } from '../providers/providers.module';
import { FollowupService } from './followup.service';

@Module({
  imports: [ProvidersModule, BrainModule, MemoryModule],
  providers: [FollowupService],
})
export class FollowupModule {}
