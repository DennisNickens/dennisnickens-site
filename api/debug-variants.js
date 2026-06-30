module.exports = async function handler(req, res) {
  const r = await fetch('https://api.printify.com/v1/shops/' + process.env.PRINTIFY_SHOP_ID + '/products/6a3fd211e7b8a9601e0f64cd.json', { headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_API_TOKEN } });
  const data = await r.json();
  res.json({ total: data.variants?.length, v1: data.variants?.[0], v2: data.variants?.[1] });
};
