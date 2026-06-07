import * as MinIO from 'minio';
import { Readable } from 'stream';
import pino from 'pino';
import * as https from 'https';
import * as fs from 'fs';

export interface StorageRef {
  bucket: string;
  key: string;
  legacy: boolean;
}

export function withStoragePrefix(objectName: string, prefix: string): string {
  const clean = objectName.replace(/^\/+/, '');
  if (
    !clean ||
    clean.includes('\\') ||
    clean.split('/').some(part => part === '..' || part === '')
  ) {
    throw new Error(`unsafe object name: ${objectName}`);
  }
  return prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/${clean}` : clean;
}

export function parseStorageRefValue(ref: string, legacyBucket: string): StorageRef {
  if (ref.startsWith('s3://')) {
    const parsed = new URL(ref);
    const key = parsed.pathname.slice(1);
    if (!parsed.hostname || !key) {
      throw new Error(`invalid s3 uri: ${ref}`);
    }
    return { bucket: parsed.hostname, key, legacy: false };
  }
  return { bucket: legacyBucket, key: ref, legacy: true };
}

export class MinIOClient {
  private client: MinIO.Client;
  private legacyClient: MinIO.Client;
  private bucketName: string;
  private legacyBucketName: string;
  private prefix: string;
  private logger: pino.Logger;

  constructor(
    endpoint: string,
    accessKey: string,
    secretKey: string,
    bucketName: string = 'whatsapp-attachments',
    useSSL: boolean = false,
    caCertPath?: string
  ) {
    const primaryEndpoint = process.env.S3_ENDPOINT || endpoint;
    const primaryAccessKey = process.env.AWS_ACCESS_KEY_ID || accessKey;
    const primarySecretKey = process.env.AWS_SECRET_ACCESS_KEY || secretKey;
    const primaryBucket = process.env.S3_BUCKET || bucketName;
    this.prefix = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');

    const parsed = this.parseEndpoint(primaryEndpoint, useSSL);

    const clientOptions: MinIO.ClientOptions = {
      endPoint: parsed.host,
      port: parsed.port,
      useSSL: parsed.useSSL,
      accessKey: primaryAccessKey,
      secretKey: primarySecretKey,
    };

    // Add custom CA certificate for TLS verification if provided
    if (useSSL && caCertPath) {
      const ca = fs.readFileSync(caCertPath, 'utf-8');
      clientOptions.transportAgent = new https.Agent({
        ca: ca,
        rejectUnauthorized: true,
      });
    }

    this.client = new MinIO.Client(clientOptions);
    this.bucketName = primaryBucket;
    this.legacyBucketName = process.env.LEGACY_MINIO_BUCKET || bucketName;
    const legacyEndpoint = process.env.LEGACY_MINIO_ENDPOINT || endpoint;
    const legacy = this.parseEndpoint(legacyEndpoint, useSSL);
    this.legacyClient = new MinIO.Client({
      endPoint: legacy.host,
      port: legacy.port,
      useSSL: legacy.useSSL,
      accessKey: process.env.LEGACY_MINIO_ACCESS_KEY || accessKey,
      secretKey: process.env.LEGACY_MINIO_SECRET_KEY || secretKey,
    });
    this.logger = pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    });
  }

  private parseEndpoint(
    endpoint: string,
    fallbackSSL: boolean
  ): { host: string; port: number; useSSL: boolean } {
    const withScheme = /^https?:\/\//i.test(endpoint)
      ? endpoint
      : `${fallbackSSL ? 'https' : 'http'}://${endpoint}`;
    const parsed = new URL(withScheme);
    return {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 9000,
      useSSL: parsed.protocol === 'https:',
    };
  }

  private withPrefix(objectName: string): string {
    return withStoragePrefix(objectName, this.prefix);
  }

  private parseStorageRef(ref: string): StorageRef {
    return parseStorageRefValue(ref, this.legacyBucketName);
  }

  /**
   * Ensures the bucket exists
   */
  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucketName);
    if (!exists) {
      await this.client.makeBucket(this.bucketName, 'us-east-1');
      this.logger.info(`Created bucket: ${this.bucketName}`);
    }
  }

  /**
   * Uploads a file to MinIO
   */
  async uploadFile(
    objectName: string,
    data: Buffer | Readable,
    contentType?: string,
    metadata?: Record<string, string>
  ): Promise<string> {
    await this.ensureBucket();

    const metaData: Record<string, string> = {};
    if (contentType) {
      metaData['Content-Type'] = contentType;
    }
    if (metadata) {
      Object.assign(metaData, metadata);
    }

    const key = this.withPrefix(objectName);
    const size = Buffer.isBuffer(data) ? data.length : undefined;
    await this.client.putObject(this.bucketName, key, data, size, metaData);
    this.logger.debug(`Uploaded file: ${key}`);

    return `s3://${this.bucketName}/${key}`;
  }

  /**
   * Downloads a file from MinIO
   */
  async downloadFile(objectName: string): Promise<Buffer> {
    const ref = this.parseStorageRef(objectName);
    const stream = await (ref.legacy ? this.legacyClient : this.client).getObject(
      ref.bucket,
      ref.key
    );
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /**
   * Gets a presigned URL for downloading (expires in 1 hour)
   */
  async getPresignedUrl(objectName: string, expiresInSeconds: number = 3600): Promise<string> {
    const ref = this.parseStorageRef(objectName);
    return await (ref.legacy ? this.legacyClient : this.client).presignedGetObject(
      ref.bucket,
      ref.key,
      expiresInSeconds
    );
  }

  /**
   * Deletes a file from MinIO
   */
  async deleteFile(objectName: string): Promise<void> {
    const ref = this.parseStorageRef(objectName);
    await (ref.legacy ? this.legacyClient : this.client).removeObject(ref.bucket, ref.key);
    this.logger.debug(`Deleted file: ${objectName}`);
  }

  /**
   * Checks if a file exists
   */
  async fileExists(objectName: string): Promise<boolean> {
    try {
      const ref = this.parseStorageRef(objectName);
      await (ref.legacy ? this.legacyClient : this.client).statObject(ref.bucket, ref.key);
      return true;
    } catch (error) {
      if ((error as any).code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }
}
