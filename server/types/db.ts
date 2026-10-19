// Row types mirroring the SQL tables (snake_case, as Postgres returns them).

export type UserRow = {
  id: number;
  name: string;
  email: string;
  email_verified: boolean;
  image: string | null;
  created_at: Date;
  updated_at: Date;
};

export type AudioFileRow = {
  id: number;
  user_id: number;
  name: string;
  s3_key: string;
  audio_length_seconds: number;
  created_at: Date;
};
