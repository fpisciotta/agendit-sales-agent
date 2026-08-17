// src/webhook/firma-meta.guard.ts — Verifica que el webhook venga de Meta
//
// Sin esto, cualquiera que conozca la URL puede postear eventos falsos: hacer
// que el agente le escriba a números arbitrarios, gastar cuota del modelo y
// mandar mensajes de WhatsApp en nombre del negocio. En local no importaba;
// con la URL pública de producción, sí.
//
// Meta firma cada POST con HMAC-SHA256 usando la clave secreta de la app y lo
// manda en el header X-Hub-Signature-256.

import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

@Injectable()
export class FirmaMetaGuard implements CanActivate {
  private readonly logger = new Logger(FirmaMetaGuard.name);
  private readonly appSecret = process.env.META_APP_SECRET ?? '';
  private avisoEmitido = false;

  canActivate(contexto: ExecutionContext): boolean {
    const req = contexto.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();

    // Sin secreto configurado no se puede validar. Se deja pasar para no
    // romper el desarrollo local, pero avisando una vez: en producción esto
    // es un agujero.
    if (!this.appSecret) {
      if (!this.avisoEmitido) {
        this.logger.warn(
          'META_APP_SECRET no configurado: el webhook acepta cualquier POST sin verificar la firma',
        );
        this.avisoEmitido = true;
      }
      return true;
    }

    const firma = req.header('x-hub-signature-256');
    if (!firma) {
      this.logger.warn('POST al webhook sin X-Hub-Signature-256, rechazado');
      return false;
    }

    // Hay que firmar el cuerpo EXACTO que mandó Meta. Si se re-serializa el
    // JSON parseado, el más mínimo cambio de formato cambia el hash y toda
    // firma válida se vería como inválida.
    const cuerpo = req.rawBody;
    if (!cuerpo) {
      this.logger.error(
        'No hay rawBody disponible: falta rawBody:true en NestFactory.create (main.ts)',
      );
      return false;
    }

    const esperada = 'sha256=' + createHmac('sha256', this.appSecret).update(cuerpo).digest('hex');

    const a = Buffer.from(firma);
    const b = Buffer.from(esperada);
    // Comparación de tiempo constante: un === común filtra información sobre
    // el hash correcto por el tiempo que tarda en diferir.
    const valida = a.length === b.length && timingSafeEqual(a, b);

    if (!valida) {
      this.logger.warn('Firma de Meta inválida, POST rechazado');
    }
    return valida;
  }
}
