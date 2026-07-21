import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import appConfiguration from './app.configuration';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerCustomOptions,
  SwaggerDocumentOptions,
  SwaggerModule,
} from '@nestjs/swagger';
import { useContainer } from 'class-validator';
import * as cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const configuration = appConfiguration();
  const port = configuration.PORT || 9000;

  // cookie-parser is CommonJS; Nest/TS resolves it as a namespace import.
  app.use((cookieParser as unknown as () => ReturnType<typeof cookieParser>)());
  app.use(json({ limit: '24mb' }));
  app.use(urlencoded({ extended: true, limit: '24mb' }));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.enableCors({
    origin: configuration.CLIENT_HOST.split(',').map((origin) => origin.trim()),
    credentials: true,
  });
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  const config = new DocumentBuilder()
    .setTitle('Cybrain Worksheet Mangaement APIs')
    .setDescription('Cybrain Worksheet Mangaement API Documentation')
    .setVersion('1.0')
    .addTag('Routes')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        in: 'header',
      },
      'bearer',
    )
    .build();
  const options: SwaggerDocumentOptions = {
    operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
  };

  const customOptions: SwaggerCustomOptions = {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customSiteTitle: 'Expense Tracker API Docs',
  };
  const document = SwaggerModule.createDocument(app, config, options);
  SwaggerModule.setup('api', app, document, customOptions);
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(
    `✅ Redis cache store: ${process.env.REDIS_HOST || 'localhost'}:${
      process.env.REDIS_PORT || 6379
    }`,
  );
  console.log(
    `✅ Connected to PostgreSQL at ${process.env.PG_HOST || 'localhost'}:${process.env.PG_PORT || 5432}`,
  );
  console.log(`Application is running on: ${await app.getUrl()}/api`);
}
void bootstrap();
