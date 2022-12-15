import { Authorized, Arg, Ctx, Field, ObjectType, Resolver, Query, Mutation } from 'type-graphql';
import { Membership, MembershipOrderByWithRelationInput } from '@generated/type-graphql';
import { MembershipAcceptanceStatus, MembershipRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { AuthRoles } from '../auth';
import { AuthLoggingContext } from '../middleware';

@ObjectType()
class UserMemberships {
  @Field(() => [Membership])
  memberships: Membership[];
}

@ObjectType()
class TeamMemberships {
  @Field()
  totalCount: number;

  @Field(() => [Membership])
  memberships: Membership[];

  @Field()
  error: Error | null;
}

@ObjectType()
class MembershipMutationPayload {
  @Field(() => Membership)
  membership: Membership | null;

  @Field()
  error: Error | null;
}

enum MembershipSort {
  DATE = 'date',
  ROLE = 'role',
  ACCEPTANCE_STATUS = 'acceptance_status',
}

interface Error {
  message: string;
}

@Resolver(() => Membership)
export class MembershipResolver {
  @Authorized(AuthRoles.Address)
  @Query(() => UserMemberships, { nullable: true })
  async userMemberships(
    @Ctx() { prisma, userAccessTokenPayload, logger }: AuthLoggingContext,
  ): Promise<UserMemberships | null> {
    logger.info(`Request for Memberships for address`);

    if (userAccessTokenPayload === null) {
      logger.error('Route passed AuthRoles.Address authorization without user payload set');
      return null;
    }

    const memberships = await prisma.membership.findMany({
      where: {
        address: {
          ethAddress: userAccessTokenPayload.address.toLowerCase(),
        },
      },
    });

    logger.debug(`Completed request for Memberships for address ${userAccessTokenPayload.address}`);

    return {
      memberships,
    };
  }

  @Authorized(AuthRoles.Address)
  @Query(() => TeamMemberships, { nullable: true })
  async teamMemberships(
    @Ctx() { prisma, userAccessTokenPayload, logger }: AuthLoggingContext,
    @Arg('teamId') teamId: number,
    @Arg('sort', { defaultValue: MembershipSort.DATE }) sort: MembershipSort,
    @Arg('perPage', { defaultValue: null }) perPage?: number,
    @Arg('page', { defaultValue: null }) page?: number,
  ): Promise<TeamMemberships> {
    logger.info(
      `Request for Memberships for team ${teamId} using sort ${sort}, with ${perPage} results per page and page ${page}`,
    );

    if (userAccessTokenPayload === null) {
      logger.error('Route passed AuthRoles.Address authorization without user payload set');
      return {
        totalCount: 0,
        memberships: [],
        error: {
          message: 'Not authenticated',
        },
      };
    }

    let orderBy: MembershipOrderByWithRelationInput | undefined = undefined;
    switch (sort) {
      case MembershipSort.DATE:
        orderBy = {
          joinedOn: 'desc',
        };
        break;
      case MembershipSort.ROLE:
        orderBy = {
          role: 'asc',
        };
        break;
      case MembershipSort.ACCEPTANCE_STATUS:
        orderBy = {
          acceptanceStatus: 'asc',
        };
        break;
      default:
        logger.warn(`Unknown value provided for sort: ${sort}`);
        return {
          totalCount: 0,
          memberships: [],
          error: {
            message: `Unknown value provided for sort: ${sort}`,
          },
        };
    }

    if ((page === null || perPage === null) && page !== perPage) {
      logger.warn('"page" and "perPage" must be specified together');
      return {
        totalCount: 0,
        memberships: [],
        error: {
          message: '"page" and "perPage" must be specified together',
        },
      };
    }
    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        ownerAddress: true,
      },
    });

    if (team === null) {
      logger.warn('Team not found');
      return {
        totalCount: 0,
        memberships: [],
        error: {
          message: 'Team not found',
        },
      };
    }

    if (
      team.ownerAddress.ethAddress.toLowerCase() !== userAccessTokenPayload.address.toLowerCase()
    ) {
      logger.warn('Not a team owner');
      return {
        totalCount: 0,
        memberships: [],
        error: {
          message: 'Not authorized',
        },
      };
    }

    const totalCount = await prisma.membership.count({
      where: {
        team: {
          id: teamId,
        },
      },
    });

    const memberships = await prisma.membership.findMany({
      orderBy,
      skip: page ? (page - 1) * <number>perPage : undefined,
      take: perPage ?? undefined,
      where: {
        team: {
          id: teamId,
        },
      },
    });

    logger.debug(
      `Completed request for Memberships for team ${teamId} using sort ${sort}, with ${perPage} results per page and page ${page}`,
    );

    return {
      totalCount,
      memberships,
      error: null,
    };
  }

  @Authorized(AuthRoles.Address)
  @Mutation(() => MembershipMutationPayload)
  async addNewMembership(
    @Ctx() { prisma, userAccessTokenPayload, logger }: AuthLoggingContext,
    @Arg('teamId') teamId: number,
    @Arg('address') address: string,
  ): Promise<MembershipMutationPayload> {
    logger.info(`Request to add user with address: ${address} as a member to team ${teamId}`);

    if (userAccessTokenPayload === null) {
      logger.error('Route passed AuthRoles.Address authorization without user payload set');
      return {
        membership: null,
        error: {
          message: 'Not authenticated',
        },
      };
    }

    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
        ownerAddress: true,
      },
    });

    if (team === null) {
      logger.warn(`Team not found for teamId: ${teamId}`);
      return {
        membership: null,
        error: {
          message: `Team not found for teamId: ${teamId}`,
        },
      };
    }

    if (
      team.ownerAddress.ethAddress.toLowerCase() !== userAccessTokenPayload.address.toLowerCase()
    ) {
      logger.warn('Not a team owner');
      return {
        membership: null,
        error: {
          message: 'Not authorized',
        },
      };
    }

    const addressRecord = await prisma.address.findUnique({
      where: {
        ethAddress: address.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    if (addressRecord === null) {
      logger.warn(`Address not found for address: ${address}`);
      return {
        membership: null,
        error: {
          message: `Address not found for address: ${address}`,
        },
      };
    }

    const membership = await prisma.membership.create({
      data: {
        team: {
          connect: {
            id: teamId,
          },
        },
        address: {
          connect: {
            ethAddress: address.toLowerCase(),
          },
        },
        role: MembershipRole.ADMIN,
        acceptanceStatus: MembershipAcceptanceStatus.PENDING,
      },
    });

    logger.debug(
      `Completed request to add user with address: ${address} as a member to team ${teamId}`,
    );

    return {
      membership,
      error: null,
    };
  }

  @Authorized(AuthRoles.Address)
  @Mutation(() => MembershipMutationPayload)
  async removeMembership(
    @Ctx() { prisma, userAccessTokenPayload, logger }: AuthLoggingContext,
    @Arg('teamId') teamId: number,
    @Arg('address') address: string,
  ): Promise<MembershipMutationPayload> {
    logger.info(`Request to remove a membership from team ${teamId} for address ${address}`);

    if (userAccessTokenPayload === null) {
      logger.error('Route passed AuthRoles.Address authorization without user payload set');
      return {
        membership: null,
        error: {
          message: 'Not authenticated',
        },
      };
    }

    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
        ownerAddress: true,
      },
    });

    if (team === null) {
      logger.warn(`Team not found for teamId: ${teamId}`);
      return {
        membership: null,
        error: {
          message: `Team not found for teamId: ${teamId}`,
        },
      };
    }

    if (
      team.ownerAddress.ethAddress.toLowerCase() !== userAccessTokenPayload.address.toLowerCase()
    ) {
      logger.warn('Not a team owner');
      return {
        membership: null,
        error: {
          message: 'Not authorized',
        },
      };
    }

    const addressRecord = await prisma.address.findUnique({
      where: {
        ethAddress: address.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    if (addressRecord === null) {
      logger.warn(`Address not found for address: ${address}`);
      return {
        membership: null,
        error: {
          message: `Address not found for address: ${address}`,
        },
      };
    }

    const membership = await prisma.membership.delete({
      where: {
        teamId_addressId: {
          teamId,
          addressId: addressRecord.id,
        },
      },
    });

    logger.debug(
      `Completed request to remove a membership from team ${teamId} for address ${address}`,
    );

    return {
      membership,
      error: null,
    };
  }

  @Authorized(AuthRoles.Address)
  @Mutation(() => MembershipMutationPayload)
  async acceptMembership(
    @Ctx() { prisma, userAccessTokenPayload, logger }: AuthLoggingContext,
    @Arg('teamId') teamId: number,
  ): Promise<MembershipMutationPayload> {
    logger.info(`Request to accept a membership to team ${teamId}`);

    if (userAccessTokenPayload === null) {
      logger.error('Route passed AuthRoles.Address authorization without user payload set');
      return {
        membership: null,
        error: {
          message: 'Not authenticated',
        },
      };
    }

    const team = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
      },
    });

    if (team === null) {
      logger.warn(`Team not found for teamId: ${teamId}`);
      return {
        membership: null,
        error: {
          message: `Team not found for teamId: ${teamId}`,
        },
      };
    }

    const addressRecord = await prisma.address.findUnique({
      where: {
        ethAddress: userAccessTokenPayload.address.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    if (addressRecord === null) {
      logger.warn(`Address not found for address: ${userAccessTokenPayload.address}`);
      return {
        membership: null,
        error: {
          message: `Address not found for address: ${userAccessTokenPayload.address}`,
        },
      };
    }

    const membership = await prisma.membership.findUnique({
      where: {
        teamId_addressId: {
          teamId,
          addressId: addressRecord.id,
        },
      },
    });

    if (membership === null) {
      logger.warn(
        `Membership not found for team ${teamId} address: ${userAccessTokenPayload.address}`,
      );
      return {
        membership: null,
        error: {
          message: `Membership not found for team ${teamId} address: ${userAccessTokenPayload.address}`,
        },
      };
    }

    if (membership.acceptanceStatus !== MembershipAcceptanceStatus.PENDING) {
      logger.warn(`Membership is already accepted: ${userAccessTokenPayload.address}`);
      return {
        membership: null,
        error: {
          message: `Membership is already accepted: ${userAccessTokenPayload.address}`,
        },
      };
    }

    const result = await prisma.membership.update({
      where: {
        teamId_addressId: {
          teamId,
          addressId: addressRecord.id,
        },
      },
      data: {
        acceptanceStatus: MembershipAcceptanceStatus.ACCEPTED,
        joinedOn: DateTime.now().toJSDate(),
      },
    });

    logger.debug(
      `Completed request to accept a membership to team ${teamId} for address ${userAccessTokenPayload.address}`,
    );

    return {
      membership: result,
      error: null,
    };
  }
}
