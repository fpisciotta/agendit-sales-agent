// src/config/agent-config.module.ts

import { Module } from '@nestjs/common';

import { PromptsConfigService } from './prompts-config.service';

@Module({
  providers: [PromptsConfigService],
  exports: [PromptsConfigService],
})
export class AgentConfigModule {}
