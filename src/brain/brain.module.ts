// src/brain/brain.module.ts

import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AgentConfigModule } from '../config/agent-config.module';
import { BrainService } from './brain.service';

@Module({
  imports: [AiModule, AgentConfigModule],
  providers: [BrainService],
  exports: [BrainService],
})
export class BrainModule {}
