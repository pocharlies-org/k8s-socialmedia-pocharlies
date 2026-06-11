import { MinIOClient, parseStorageRefValue, withStoragePrefix } from './minio-client';

describe('shared S3 storage helpers', () => {
  it('parses durable s3 refs as primary storage', () => {
    expect(parseStorageRefValue('s3://skirmshop-drive/socialmedia/attachments/1/a.jpg', 'legacy')).toEqual({
      bucket: 'skirmshop-drive',
      key: 'socialmedia/attachments/1/a.jpg',
      legacy: false,
    });
  });

  it('keeps raw keys on legacy MinIO bucket', () => {
    expect(parseStorageRefValue('attachments/1/a.jpg', 'socialmedia-media')).toEqual({
      bucket: 'socialmedia-media',
      key: 'attachments/1/a.jpg',
      legacy: true,
    });
  });

  it('applies socialmedia prefix to new object keys', () => {
    expect(withStoragePrefix('attachments/1/a.jpg', 'socialmedia')).toBe('socialmedia/attachments/1/a.jpg');
  });

  it('rejects path traversal in new object keys', () => {
    expect(() => withStoragePrefix('../bad.jpg', 'socialmedia')).toThrow(/unsafe/);
  });
});

const integrationDescribe = process.env.RUN_S3_INTEGRATION === '1' ? describe : describe.skip;

integrationDescribe('shared S3 storage integration', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://127.0.0.1:9000';
    process.env.S3_BUCKET = process.env.S3_BUCKET || 'skirmshop-drive-it';
    process.env.S3_PREFIX = process.env.S3_PREFIX || 'socialmedia';
    process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'minioadmin';
    process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin';
  });

  afterEach(() => {
    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_PREFIX', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  });

  it('roundtrips new media through primary S3 storage', async () => {
    const client = new MinIOClient(
      process.env.S3_ENDPOINT!,
      process.env.AWS_ACCESS_KEY_ID!,
      process.env.AWS_SECRET_ACCESS_KEY!,
      process.env.S3_BUCKET!,
      false
    );

    const uri = await client.uploadFile('attachments/test/hello.txt', Buffer.from('hello s3'), 'text/plain');

    expect(uri).toBe(`s3://${process.env.S3_BUCKET}/socialmedia/attachments/test/hello.txt`);
    expect(await client.fileExists(uri)).toBe(true);
    expect(await client.downloadFile(uri)).toEqual(Buffer.from('hello s3'));
    expect(await client.getPresignedUrl(uri, 60)).toMatch(/^http/);

    await client.deleteFile(uri);
    expect(await client.fileExists(uri)).toBe(false);
  });
});
