# ── build stage ────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── runtime stage ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# chrony/NTP อยู่ที่ host — นาฬิกาเครื่องนี้คือลำดับ received_at และวันที่ พ.ศ.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# ⚠️ script ดึงข้อมูลจาก ERP ต้องอยู่ใน image — เป็น "สัญญา" กับฝ่าย ERP ที่ต้องมี
#    version control ไม่ใช่ไฟล์ที่วางมือบนเครื่อง server (เคยพลาดตรงนี้: ตั้ง
#    ERP_SQL_ITEMS_SQL_FILE แล้ว container หาไฟล์ไม่เจอเพราะไม่ได้ COPY เข้ามา)
COPY sql ./sql
# db/schema.sql ถูก mount โดย compose สำหรับ init ครั้งแรก
USER node
EXPOSE 8080
# ⚠️ คอนเทนเนอร์นี้ **ไม่ได้รัน migration ตอน boot** (`dist/main.js` ไม่แตะ DB เลยก่อน
#    listen — ดู src/main.ts) migration คือ `npm run migrate` ที่มนุษย์รันเอง ก่อน build
#    และสลับคอนเทนเนอร์เสมอ (ดู deploy/update.sh ขั้น 4)
CMD ["node", "dist/main.js"]
