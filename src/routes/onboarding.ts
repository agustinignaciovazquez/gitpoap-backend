import { Router } from 'express';
import { Octokit } from 'octokit';
import { z } from 'zod';
import multer from 'multer';
import { DateTime } from 'luxon';
import { uploadMulterFile, s3configProfile, s3, getS3URL } from '../external/s3';
import {
  PutItemCommand,
  PutItemCommandInput,
  ScanCommand,
  ScanCommandInput,
  UpdateItemCommand,
  UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';
import { configProfile, dynamoDBClient } from '../external/dynamo';
import { createScopedLogger } from '../logging';
import { httpRequestDurationSeconds } from '../metrics';
import { jwtWithOAuth } from '../middleware';
import { AccessTokenPayloadWithOAuth } from '../types/tokens';
import { postmarkClient } from '../external/postmark';
import {
  IntakeFormImageFilesSchema,
  IntakeFormReposSchema,
  IntakeFormSchema,
} from '../schemas/onboarding';

type Repo = {
  name: string;
  full_name: string;
  githubRepoId: number;
  description: string | null;
  url: string;
  owner: {
    id: number | string;
    type: string;
    name: string;
    avatar_url: string;
    url: string;
  };
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  };
};

type PullRequestsRes = {
  search: {
    issueCount: number;
    edges: {
      node: {
        number: number;
        title: string;
        repository: {
          name: string;
          nameWithOwner: string;
          viewerPermission: string;
          databaseId: number;
          description: string;
          url: string;
          isFork: boolean;
          stargazerCount: number;
          owner: {
            id: string;
            __typename: string;
            avatarUrl: string;
            login: string;
            resourcePath: string;
          };
        };
      };
    }[];
  };
};

type ErrorMessage = {
  message: string;
};

type APIResponseData<T> = T | ErrorMessage;

const publicPRsQuery = (userName: string) => `
{
  search(
    query: "author:${userName} is:pr is:public is:merged"
    type: ISSUE
    first: 100
  ) {
    issueCount
    edges {
      node {
        ... on PullRequest {
          title
          repository {
            databaseId
            name
            nameWithOwner
            viewerPermission
            description
            url
            isFork
            stargazerCount
            owner {
              id
              __typename
              avatarUrl
              login
              resourcePath
            }
          }
        }
      }
    }
  }
}
`;

const getMappedOrgRepo = (
  repo: Awaited<ReturnType<Octokit['rest']['repos']['listForOrg']>>['data'][number],
): Repo => ({
  name: repo.name,
  full_name: repo.full_name,
  githubRepoId: repo.id,
  description: repo.description,
  url: repo.html_url,
  owner: {
    id: repo.owner.id,
    type: repo.owner.type,
    name: repo.owner.login,
    avatar_url: repo.owner.avatar_url,
    url: repo.owner.html_url,
  },
  permissions: repo.permissions,
});

const getMappedRepo = (
  repo: Awaited<ReturnType<Octokit['rest']['repos']['listForAuthenticatedUser']>>['data'][number],
): Repo => ({
  name: repo.name,
  full_name: repo.full_name,
  githubRepoId: repo.id,
  description: repo.description,
  url: repo.html_url,
  owner: {
    id: repo.owner.id,
    type: repo.owner.type,
    name: repo.owner.login,
    avatar_url: repo.owner.avatar_url,
    url: repo.owner.html_url,
  },
  permissions: repo.permissions,
});

const getMappedPrRepo = (pr: PullRequestsRes['search']['edges'][number]): Repo => ({
  name: pr.node.repository.name,
  full_name: pr.node.repository.nameWithOwner,
  githubRepoId: pr.node.repository.databaseId,
  description: pr.node.repository.description,
  url: pr.node.repository.url,
  owner: {
    id: pr.node.repository.owner.id,
    name: pr.node.repository.owner.login,
    type: pr.node.repository.owner.__typename,
    avatar_url: pr.node.repository.owner.avatarUrl,
    url: pr.node.repository.owner.resourcePath,
  },
  permissions: {
    admin: ['ADMIN'].includes(pr.node.repository.viewerPermission),
    maintain: ['MAINTAIN', 'ADMIN'].includes(pr.node.repository.viewerPermission),
    push: ['WRITE', 'MAINTAIN', 'ADMIN'].includes(pr.node.repository.viewerPermission),
    triage: ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'].includes(pr.node.repository.viewerPermission),
    pull: ['READ', 'WRITE', 'MAINTAIN', 'ADMIN'].includes(pr.node.repository.viewerPermission),
  },
});

type IntakeForm = z.infer<typeof IntakeFormSchema>;

export const onboardingRouter = Router();

const upload = multer();

const createIntakeFormDocForDynamo = (
  formData: IntakeForm,
  timestamp: number,
): PutItemCommandInput => ({
  TableName: configProfile.tables.intakeForm,
  Item: {
    'email-githubHandle': {
      S: `${formData.email}-${formData.githubHandle}`,
    },
    timestamp: {
      N: timestamp.toString(),
    },
    name: { S: formData.name ?? '' },
    email: { S: formData.email },
    notes: { S: formData.notes ?? '' },
    githubHandle: { S: formData.githubHandle },
    shouldGitPOAPDesign: { BOOL: Boolean(formData.shouldGitPOAPDesign) },
    isOneGitPOAPPerRepo: { BOOL: Boolean(formData.isOneGitPOAPPerRepo) },
    repos: {
      L: JSON.parse(formData.repos).map((repo: z.infer<typeof IntakeFormReposSchema>[number]) => ({
        M: {
          full_name: { S: repo.full_name },
          githubRepoId: { S: repo.githubRepoId },
          permissions: {
            M: {
              admin: { BOOL: repo.permissions.admin },
              maintain: { BOOL: repo.permissions.maintain ?? false },
              push: { BOOL: repo.permissions.push },
              triage: { BOOL: repo.permissions.triage ?? false },
              pull: { BOOL: repo.permissions.pull },
            },
          },
        },
      })),
    },
    isComplete: { BOOL: false },
  },
});

const createUpdateItemParamsForImages = (
  key: string,
  timestamp: number,
  imageUrls: string[],
): UpdateItemCommandInput => {
  return {
    TableName: configProfile.tables.intakeForm,
    Key: {
      'email-githubHandle': { S: key },
      timestamp: { N: timestamp.toString() },
    },
    UpdateExpression: 'set images = :images',
    ExpressionAttributeValues: {
      ':images': {
        L: imageUrls.map(url => ({ S: url })),
      },
    },
    ReturnValues: 'UPDATED_NEW',
  };
};

const formatRepos = (repos: Repo[]) => {
  let response = `${repos[0].full_name.split('/')[1]}`;
  for (let i = 1; i < repos.length; i++) {
    if (i + 1 === repos.length) {
      response += `, and ${repos[i].full_name.split('/')[1]}`;
    } else if (i < 5) {
      response += `, ${repos[i].full_name.split('/')[1]}`;
    } else {
      response += `, and ${repos.length - 5} more`;
      break;
    }
  }
  return response;
};

const sendConfirmationEmail = async (formData: IntakeForm, queueNumber: number | undefined) => {
  postmarkClient.sendEmailWithTemplate({
    From: 'team@gitpoap.io',
    To: formData.email,
    TemplateAlias: 'welcome-1',
    TemplateModel: {
      product_url: 'gitpoap.io',
      product_name: 'GitPOAP',
      queue_number: queueNumber ?? '',
      name: formData.name,
      email: formData.email,
      githubHandle: formData.githubHandle,
      shouldGitPOAPDesign: formData.shouldGitPOAPDesign === 'true' ? 'GitPOAP' : 'You',
      isOneGitPOAPPerRepo: formData.isOneGitPOAPPerRepo === 'true' ? 'One Per Repo' : 'One For All',
      notes: formData.notes,
      repos: formatRepos(JSON.parse(formData.repos)),
      support_email: 'team@gitpoap.io',
      company_name: 'MetaRep Labs Inc',
      company_address: 'One Broadway, Cambridge MA 02142',
      sender_name: 'GitPOAP Team',
      help_url: 'https://docs.gitpoap.io',
    },
  });
};

const sendInternalConfirmationEmail = async (
  formData: IntakeForm,
  queueNumber: number | undefined,
  urls: string[],
) => {
  postmarkClient.sendEmail({
    From: 'team@gitpoap.io',
    To: 'team@gitpoap.io',
    Subject: `New intake form submission from ${formData.githubHandle} / ${formData.email} `,
    TextBody: `
      New intake form submission from ${formData.githubHandle} / ${formData.email}
      Queue number: ${queueNumber ?? ''}
      Name: ${formData.name}
      Email: ${formData.email}
      Notes: ${formData.notes}
      Github Handle: ${formData.githubHandle}
      Should GitPOAP Design: ${formData.shouldGitPOAPDesign}
      Is One GitPOAP Per Repo: ${formData.isOneGitPOAPPerRepo}
      \n
      Repos:
      ${JSON.parse(formData.repos).map(
        (repo: z.infer<typeof IntakeFormReposSchema>[number]) => repo.full_name,
      )}
      \n
      Images:
      ${urls.join('\n')}
      `,
  });
};

onboardingRouter.post<'/intake-form', {}, {}, IntakeForm>(
  '/intake-form',
  jwtWithOAuth(),
  upload.array('images', 5),
  async (req, res) => {
    const logger = createScopedLogger('GET /onboarding/intake-form');
    logger.debug(`Body: ${JSON.stringify(req.body)}`);

    const endTimer = httpRequestDurationSeconds.startTimer('GET', '/onboarding/intake-form');
    const unixTime = DateTime.local().toUnixInteger();
    const intakeFormTable = configProfile.tables.intakeForm;

    logger.info(
      `Request from GitHub handle ${req.body.githubHandle} to onboard via the intake form`,
    );

    /* Validate form data */
    const schemaResult = IntakeFormSchema.safeParse(req.body);
    if (!schemaResult.success) {
      logger.warn(
        `Missing/invalid body fields in request: ${JSON.stringify(schemaResult.error.issues)}`,
      );
      endTimer({ status: 400 });
      return res.status(400).send({ issues: schemaResult.error.issues });
    }

    /* Validate repos array */
    const reposSchemaResult = IntakeFormReposSchema.safeParse(JSON.parse(req.body.repos));
    if (!reposSchemaResult.success) {
      logger.warn(
        `Missing/invalid body fields in request: ${JSON.stringify(reposSchemaResult.error.issues)}`,
      );
      endTimer({ status: 400 });
      return res.status(400).send({ issues: reposSchemaResult.error.issues });
    }

    /* Validate image files array */
    const imageSchemaResult = IntakeFormImageFilesSchema.safeParse(req.files);
    if (!imageSchemaResult.success) {
      logger.warn(
        `Missing/invalid body fields in request: ${JSON.stringify(imageSchemaResult.error.issues)}`,
      );
      endTimer({ status: 400 });
      return res.status(400).send({ issues: imageSchemaResult.error.issues });
    }

    /* Push results to Dynamo DB */
    try {
      const params = createIntakeFormDocForDynamo(req.body, unixTime);
      await dynamoDBClient.send(new PutItemCommand(params));
      logger.info(
        `Submitted intake form for GitHub user - ${req.body.githubHandle} to DynamoDB table ${intakeFormTable}`,
      );
    } catch (err) {
      logger.error(
        `Received error when pushing new item to DynamoDB table ${intakeFormTable} - ${err} `,
      );
      endTimer({ status: 400 });
      return res.status(400).send({ msg: 'Failed to submit intake form' });
    }

    /* Push images to S3 */
    const images = req.files;
    const urls = [];
    if (images && Array.isArray(images) && images?.length > 0) {
      logger.info(`Found ${images.length} images to upload to S3. Attempting to upload.`);
      for (const [index, image] of images.entries()) {
        try {
          const key = `${unixTime}-${req.body.githubHandle}-${req.body.email}-${index}`;
          await uploadMulterFile(image, s3configProfile.buckets.intakeForm, key);
          /* Get s3 file URL */
          const url = getS3URL(s3configProfile.buckets.intakeForm, key);
          urls.push(url);
          logger.info(
            `Uploaded image ${index + 1} to S3 bucket ${s3configProfile.buckets.intakeForm}`,
          );
        } catch (err) {
          logger.error(`Received error when uploading image to S3 - ${err}`);
          endTimer({ status: 400 });
          return res.status(400).send({ msg: 'Failed to submit intake form assets to S3' });
        }
      }
      logger.info(`Uploaded ${images.length}/${images.length} images to S3.`);

      /* Update new s3 image urls to the dynamo DB record with the associated private key  */
      const updateParams = createUpdateItemParamsForImages(
        `${req.body.email}-${req.body.githubHandle}`,
        unixTime,
        urls,
      );
      try {
        await dynamoDBClient.send(new UpdateItemCommand(updateParams));
        logger.info(
          `Updated DynamoDB table ${intakeFormTable} record with key: ${req.body.githubHandle} with new image URLs`,
        );
      } catch (err) {
        logger.error(`Received error when updating DynamoDB table ${intakeFormTable} - ${err} `);
        endTimer({ status: 400 });
        return res.status(400).send({ msg: 'Failed to submit image URLs to DynamoDB' });
      }
    } else {
      logger.info(`No images found to upload to S3. Skipping S3 upload step.`);
    }

    /* If successful, then dispatch confirmation email to user via PostMark. Also fetch the DynamoDB item count as a proxy for queue number */
    let tableCount = undefined;
    try {
      /* Get the count of all items within the dynamoDB table with isComplete = false */
      const params: ScanCommandInput = {
        Select: 'COUNT',
        TableName: intakeFormTable,
        FilterExpression: 'isComplete = :isComplete',
        ExpressionAttributeValues: {
          ':isComplete': { BOOL: false },
        },
      };

      const dynamoRes = await dynamoDBClient.send(new ScanCommand(params));
      tableCount = dynamoRes.Count;

      logger.info(
        `Retrieved count of all incomplete records in DynamoDB table ${intakeFormTable} - Count: ${tableCount}`,
      );

      await sendConfirmationEmail(req.body, tableCount);
      logger.info(`Sent confirmation email to ${req.body.email}`);
      await sendInternalConfirmationEmail(req.body, tableCount, urls);
      logger.info(`Sent internal confirmation email to team@gitpoap.io`);
    } catch (err) {
      /* Log error, but don't return error to user. Sending the email is secondary to storing the form data */
      logger.error(`Received error when sending confirmation email to ${req.body.email} - ${err} `);
    }

    logger.info(
      `Successfully submitted intake form for GitHub user - ${req.body.githubHandle} and email - ${req.body.email}`,
    );

    endTimer({ status: 200 });

    /* Return form data, the queue number, and a confirmation message to the user */
    return res.status(200).send({
      formData: req.body,
      queueNumber: tableCount,
      msg: 'Successfully submitted intake form',
    });
  },
);

onboardingRouter.get<'/github/repos', {}, APIResponseData<Repo[]>>(
  '/github/repos',
  jwtWithOAuth(),
  async function (req, res) {
    const logger = createScopedLogger('GET /onboarding/github/repos');
    const endTimer = httpRequestDurationSeconds.startTimer('GET', '/onboarding/github/repos');

    const token = (<AccessTokenPayloadWithOAuth>req.user).githubOAuthToken;
    const octokit = new Octokit({ auth: token });
    const user = await octokit.rest.users.getAuthenticated();

    logger.info(`Fetching repos lists for GitHub user ${user.data.login}`);

    const foundRepoIds = new Set<number>();
    const rejectedRepoIds = new Set<number>();

    let mappedPrRepos: Repo[] = [];
    let mappedRepos: Repo[] = [];
    let mappedOrgRepos: Repo[] = [];

    try {
      /* Fetch first 100 public PRs for a user */
      const publicPrs = await octokit.graphql<PullRequestsRes>(publicPRsQuery(user.data.login));

      const uniquePrRepos = publicPrs.search.edges.filter(repo => {
        /* Do NOT filter out repos based on stars */
        if (repo.node.repository.isFork) {
          rejectedRepoIds.add(repo.node.repository.databaseId);
          return false;
        }
        const isFound = foundRepoIds.has(repo.node.repository.databaseId);
        foundRepoIds.add(repo.node.repository.databaseId);

        return !isFound;
      });

      mappedPrRepos = uniquePrRepos.map((pr): Repo => getMappedPrRepo(pr));
      logger.debug(`Found ${mappedPrRepos.length} unique PR-related repos`);

      /* Fetch list of repos for authenticated user */
      const repos = await octokit.rest.repos.listForAuthenticatedUser({
        type: 'public',
        per_page: 100,
      });

      /* Fetch list of orgs that the user is a member of */
      const orgs = await octokit.rest.orgs.listForUser({
        username: user.data.login,
        per_page: 100,
      });

      /* Fetch list of repos for each org the user is a member of */
      const orgsWithRepos = await Promise.all(
        orgs.data.map(
          async org =>
            await octokit.rest.repos.listForOrg({
              org: org.login,
              per_page: 100,
            }),
        ),
      );

      /* Combine all org repos into one array */
      mappedOrgRepos = orgsWithRepos
        .map(org => org.data)
        .reduce((acc, repos) => [...acc, ...repos], [])
        .filter(repo => {
          const isFound = foundRepoIds.has(repo.id);
          foundRepoIds.add(repo.id);
          if (isFound) {
            return false;
          } else if (repo.fork) {
            rejectedRepoIds.add(repo.id);
            return false;
          } else if (!repo.stargazers_count || repo.stargazers_count < 2) {
            rejectedRepoIds.add(repo.id);
            return false;
          }
          const hasPermission =
            repo.permissions?.admin || repo.permissions?.maintain || repo.permissions?.push;
          return hasPermission;
        })
        .map(repo => getMappedOrgRepo(repo));

      /* Combine all public repos into one array */
      mappedRepos = repos.data
        .filter(repo => {
          const isFound = foundRepoIds.has(repo.id);
          foundRepoIds.add(repo.id);
          if (isFound) {
            return false;
          } else if (repo.fork) {
            rejectedRepoIds.add(repo.id);
            return false;
          } else if (!repo.stargazers_count || repo.stargazers_count < 2) {
            rejectedRepoIds.add(repo.id);
            return false;
          }
          const hasPermission =
            repo.permissions?.admin || repo.permissions?.maintain || repo.permissions?.push;
          return hasPermission;
        })
        .map(repo => getMappedRepo(repo));
    } catch (error) {
      logger.error(`Received error when fetching repos for GitHub user - ${error}`);
      endTimer({ status: 400 });
      return res.status(400).send({ message: 'Failed to fetch repos for GitHub user' });
    }

    /* Combine all repos into one array */
    const allRepos = [...mappedRepos, ...mappedOrgRepos, ...mappedPrRepos];

    logger.info(
      `Found ${allRepos.length} total applicable repos for GitHub user ${user.data.login}. Rejected ${rejectedRepoIds.size} repos.`,
    );
    endTimer({ status: 200 });

    /* Return status 200 and set a stale-while-revalidate cache-control header */
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800');
    return res.status(200).json(allRepos);
  },
);
