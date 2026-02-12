import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import appConfiguration from './app.configuration';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerCustomOptions, SwaggerDocumentOptions, SwaggerModule } from '@nestjs/swagger';
import { useContainer } from 'class-validator';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);


  const port = appConfiguration().PORT || 3000;
  // await app.listen(port);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.enableCors();
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  const config = new DocumentBuilder()
    .setTitle('Cybrain Worksheet Mangaement APIs')
    .setDescription('Cybrain Worksheet Mangaement API Documentation')
    .setVersion('1.0')
    .addTag('Routes')
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
  console.log(`✅ Connected to Redis at ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
  console.log(`✅ Connected to PostgreSQL at ${process.env.PG_HOST || 'localhost'}:${process.env.PG_PORT || 5432}`);
  console.log(`Application is running on: ${await app.getUrl()}/api`);
}
bootstrap();
