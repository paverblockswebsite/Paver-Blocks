import { createPublicCmsClient } from "./public-cms-core.js";

const cms = createPublicCmsClient(import.meta.env.VITE_PUBLIC_API_BASE_URL || "");

export const fetchPublicList = cms.fetchPublicList;
export const fetchPublicProject = cms.fetchPublicProject;
export const publicProjectImageUrl = cms.publicProjectImageUrl;
