require('dotenv').config()
export default () => ({
    PROJECT: 'Hospital Management System',
    PORT: parseInt(process.env.PORT || '3000'),

    ENVIRONMENT: process.env.NODE_ENV || 'development',
    CLIENT_HOST: process.env.CLIENT_HOST || 'http://localhost:6379',
    JWT: {
        SECRET: process.env.JWT_SECRET || 'kjhdiuwidh76uuh5egd8hd2nd93dg5hyqyshuyq',
        EXP: process.env.JWT_EXPIRES_IN || '2d',
    },
    CACHE: {
        REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
        REDIS_TTL: parseInt(process.env.REDIS_TTL || '43200'),
    },
    API: {
        GLOBAL_PREFIX: process.env.API_GLOBAL_PREFIX || `/api`,
    },
    DB: {
        TYPE: process.env.PG_TYPE,
        PORT: process.env.PG_PORT,
        HOST: process.env.PG_HOST,
        USERNAME: process.env.PG_USERNAME,
        PASSWORD: process.env.PG_PASSWORD,
        DATABASE: process.env.PG_DATABASE,
        URL: process.env.DB_URL,
    },
    SWAGGER: {
        TITLE: 'Cybrain Worksheet Mangaement APIs',
        DESCRIPTION: 'Cybrain  Worksheet Mangaement Platform',
        VERSION: '1.0.0'
    },
})