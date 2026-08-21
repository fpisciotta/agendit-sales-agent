// src/tests/calendar-local.ts — Verificar Google Calendar sin pasar por WhatsApp
//
// Uso:
//   npm run test:calendar -- --email=vos@tudominio.com
//   npm run test:calendar -- --email=vos@tudominio.com --fecha=2026-08-25 --hora=15:00
//
// OJO: crea un evento REAL y le manda la invitación por mail al --email.
// Poné tu propia dirección, no la de un cliente.

process.env.TZ = 'UTC';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { CalendarService } from '../calendar/calendar.service';
import { TZ_NEGOCIO, desdeHoraNegocio, formatearNegocio, partesEnNegocio } from '../common/tiempo';

function arg(nombre: string): string | undefined {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado?.split('=').slice(1).join('=');
}

async function main(): Promise<void> {
  const email = arg('email');
  if (!email) {
    console.error('Falta --email=vos@tudominio.com (recibe una invitación real).');
    process.exit(1);
  }

  // Por defecto, mañana a las 15:00 hora de Paraguay.
  const hoy = partesEnNegocio(new Date());
  const fecha = arg('fecha');
  const hora = arg('hora') ?? '15:00';
  const [hh, mm] = hora.split(':').map(Number);

  const inicio = fecha
    ? desdeHoraNegocio(...(fecha.split('-').map(Number) as [number, number, number]), hh, mm)
    : desdeHoraNegocio(hoy.anio, hoy.mes, hoy.dia + 1, hh, mm);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const calendar = app.get(CalendarService);

  console.log(`Zona horaria del negocio: ${TZ_NEGOCIO}`);
  console.log(`Calendario:               ${process.env.GOOGLE_CALENDAR_ID ?? 'primary'}`);
  console.log(`Actuando como:            ${process.env.GOOGLE_IMPERSONATE_EMAIL || '(sin definir)'}`);
  console.log(`Horario a probar:         ${formatearNegocio(inicio)}\n`);

  if (!calendar.habilitado) {
    console.error('Google Calendar NO está configurado.');
    console.error('Faltan GOOGLE_SERVICE_ACCOUNT_JSON y/o GOOGLE_IMPERSONATE_EMAIL.');
    await app.close();
    process.exit(1);
  }

  const r = await calendar.agendarDemo({
    inicio,
    emailCliente: email,
    nombreCliente: 'Prueba',
    telefono: '595000000000',
  });

  if (r.ok) {
    console.log('OK — evento creado.');
    console.log(`Meet: ${r.meetUrl ?? 'SIN ENLACE (revisá que la cuenta impersonada tenga Meet)'}`);
    console.log('\nBorralo a mano desde Google Calendar cuando termines de mirar.');
  } else if (r.alternativas?.length) {
    console.log(`Ese horario está ocupado. Libres ese día: ${r.alternativas.join(', ')}`);
    console.log('(La conexión con Google funciona: pudo leer la agenda.)');
  } else {
    console.error(`FALLÓ: ${r.motivo}`);
    console.error(pista(r.motivo ?? ''));
  }

  await app.close();
}

/** Traduce los errores típicos del armado en Google. */
function pista(motivo: string): string {
  if (motivo.includes('unauthorized_client')) {
    return '→ Falta autorizar el Client ID en Admin de Workspace, o el scope no coincide exacto.\n' +
      '  Seguridad → Controles de API → Delegación en todo el dominio.';
  }
  if (motivo.includes('invalid_grant')) {
    return '→ GOOGLE_IMPERSONATE_EMAIL no existe en el dominio, o no es una cuenta del Workspace.';
  }
  if (motivo.includes('notFound') || motivo.includes('Not Found')) {
    return '→ GOOGLE_CALENDAR_ID no existe para la persona impersonada. Probá con "primary".';
  }
  if (motivo.includes('has not been used') || motivo.includes('disabled')) {
    return '→ La Google Calendar API no está habilitada en ese proyecto de Google Cloud.';
  }
  if (motivo.includes('ENOENT')) {
    return '→ La ruta de GOOGLE_SERVICE_ACCOUNT_JSON no existe desde donde corrés el proceso.';
  }
  return '';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
