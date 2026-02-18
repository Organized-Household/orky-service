export default async function handler(req: any, res: any) {
  res.status(200).json({
    service: "orky-service",
    status: "alive",
    time: new Date().toISOString()
  });
}
