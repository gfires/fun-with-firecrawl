/** @type {import('next').NextConfig} */
const nextConfig = {
  // Nothing exotic needed. The scan pipeline runs entirely inside a route handler,
  // so there are no server-action body-size limits to raise here.
};

export default nextConfig;
