import bcrypt from 'bcrypt';
import { Request, Response, NextFunction } from 'express';
import { ApiCredential } from '../../model/apiCredential';

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const raw = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!raw) {
    return res.status(401).send({ error: 'Missing API key', status: 401 });
  }

  const credentials = await ApiCredential.findAll({ where: { active: true } });
  for (const cred of credentials) {
    if (await bcrypt.compare(raw, cred.keyHash)) {
      return next();
    }
  }

  return res.status(401).send({ error: 'Invalid API key', status: 401 });
}
