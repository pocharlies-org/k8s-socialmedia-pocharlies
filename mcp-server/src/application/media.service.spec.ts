import { MediaService } from './media.service';
import { AttachmentType } from '../domain/entities/attachment.entity';

describe('MediaService', () => {
  it('returns durable s3 refs from uploads', async () => {
    const minio = {
      uploadFile: jest
        .fn()
        .mockResolvedValue('s3://skirmshop-drive/socialmedia/attachments/msg-1/file.jpg'),
    };
    const db = {} as any;
    const service = new MediaService(minio as any, db);

    const ref = await service.uploadAttachment('msg-1', Buffer.from('image'), AttachmentType.IMAGE, 'image/jpeg');

    expect(ref).toBe('s3://skirmshop-drive/socialmedia/attachments/msg-1/file.jpg');
    expect(minio.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(/^attachments\/msg-1\/\d+\.jpg$/),
      expect.any(Buffer),
      'image/jpeg',
      expect.objectContaining({ messageId: 'msg-1', attachmentType: AttachmentType.IMAGE })
    );
  });
});
