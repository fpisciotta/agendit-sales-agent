// src/webhook/webhook.controller.ts — Endpoints del webhook de WhatsApp

import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { PROVEEDOR_WHATSAPP, ProveedorWhatsApp } from '../providers/whatsapp-provider.interface';
import { WebhookService } from './webhook.service';

@Controller()
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    @Inject(PROVEEDOR_WHATSAPP) private readonly proveedor: ProveedorWhatsApp,
    private readonly webhook: WebhookService,
  ) {}

  @Get()
  healthCheck() {
    return { status: 'ok', service: 'agendit-sales-agent' };
  }

  /** Verificación GET del webhook — Meta espera el challenge en texto plano. */
  @Get('webhook')
  verificar(@Req() req: Request, @Res() res: Response): void {
    const challenge = this.proveedor.validarWebhook(req);
    if (challenge !== null) {
      res.type('text/plain').send(challenge);
      return;
    }
    this.logger.warn('Verificación de webhook rechazada: verify token incorrecto');
    res.status(403).json({ status: 'forbidden' });
  }

  /**
   * Recibe los eventos de WhatsApp.
   *
   * Respondemos 200 de inmediato y procesamos en segundo plano: si Meta no
   * recibe un 200 rápido reintenta el mismo evento, y terminaríamos
   * respondiéndole dos veces al cliente.
   */
  @Post('webhook')
  @HttpCode(200)
  recibir(@Body() body: unknown) {
    void this.webhook
      .procesar(body)
      .catch((error) => this.logger.error(`Error procesando webhook: ${(error as Error).message}`));
    return { status: 'ok' };
  }
}
