import { createPublicCmsClient, selectPublicApiBase } from "./public-cms-core.js";

const apiBase = selectPublicApiBase(
  import.meta.env.VITE_PUBLIC_API_BASE_URL || "",
  import.meta.env.CF_PAGES_BRANCH || "",
);
const cms = createPublicCmsClient(apiBase);

export const fetchPublicList = cms.fetchPublicList;
export const fetchPublicProject = cms.fetchPublicProject;
export const publicProjectImageUrl = cms.publicProjectImageUrl;
